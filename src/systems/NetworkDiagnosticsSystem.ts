import { BUILDINGS, getBuildingFootprint } from '../data/buildings.data';
import { getRoadProperties, isRoadAllowedForVehicle, ROADS, RoadType } from '../data/roads.data';
import { FeatureType, isTreeFeature } from '../data/trees.data';
import type { ChunkManager } from '../core/ChunkManager';
import {
  NetworkDiagnosticIssue,
  NetworkDiagnosticsSnapshot,
  TileFlag,
  TreeStage,
  WorldEngineState,
} from '../core/GameState';
import { CHUNK_SIZE, chunkToGrid } from '../core/IsoMath';
import { PathfindingSystem } from './PathfindingSystem';
import type { RoadNetworkSystem } from './RoadNetworkSystem';
import type { ForestryFleetSystem } from './ForestryFleetSystem';
import { UtilityNetworkSystem } from './UtilityNetworkSystem';

/**
 * NetworkDiagnosticsSystem is the single place that answers "why is this not
 * working?". It reads the *actual* simulation state from all three layers:
 *
 *  Layer 1 (road connectivity) -> RoadNetworkSystem graph + junction registry
 *  Layer 2 (traffic)           -> live vehicle agents + congestion samples
 *  Layer 3 (utilities)         -> UtilityNetworkSystem per-building reasons
 *
 * It never invents connectivity and never reports a failure without naming the
 * exact tile, building or vehicle responsible.
 */
export class NetworkDiagnosticsSystem {
  /** Throttle: a full diagnostic pass is cheap but not free — rebuild at most
   *  every 20 ticks unless the caller explicitly forces it. */
  private static lastBuildTick = -999;
  private static lastSnapshot: NetworkDiagnosticsSnapshot | null = null;

  public static build(
    state: WorldEngineState,
    chunks: ChunkManager,
    roadNet: RoadNetworkSystem,
    fleet: ForestryFleetSystem,
    roadVehicles: ReadonlyArray<{
      id: number;
      kind: string;
      state: string;
      gx: number;
      gy: number;
      vehicleClass: string;
      route: Array<{ gx: number; gy: number }>;
      routeIdx: number;
      destBuildingId?: number;
      sourceBuildingId?: number;
      statusReason?: string;
      blockedSec: number;
    }>,
    force = false
  ): NetworkDiagnosticsSnapshot {
    // Cached snapshot keeps the UI at 60fps without re-walking the whole graph.
    if (!force && this.lastSnapshot && state.tick - this.lastBuildTick < 20) {
      return this.lastSnapshot;
    }
    this.lastBuildTick = state.tick;

    // Road layer: recompute is safe here (only runs when dirty).
    roadNet.recomputeIfDirty(chunks, state);

    const road: NetworkDiagnosticIssue[] = [];
    const utility: NetworkDiagnosticIssue[] = [];
    const vehicle: NetworkDiagnosticIssue[] = [];
    const forestry: NetworkDiagnosticIssue[] = [];

    // ---------------- Layer 1: road connectivity ---------------------------
    for (const issue of roadNet.diagnoseRoadNetwork(state, chunks)) {
      road.push({
        code: issue.code,
        layer: 'road',
        severity: issue.code === 'building_no_road_access' ? 'error' : 'warning',
        gx: issue.gx,
        gy: issue.gy,
        title: issue.title,
        detail: issue.detail,
        buildingId: issue.buildingId,
      });
    }

    // Road tiles that are structurally fine but unreachable from the main network.
    for (const [clusterId, info] of roadNet.getAllClusterStats()) {
      if (info.roadClass !== 'road') continue;
      if (!info.isDisconnected) continue;
      if (info.count <= 1) continue;
      // Pick the first tile in the cluster as the reporting anchor.
      let anchor: { gx: number; gy: number } | null = null;
      for (const ep of roadNet.getDanglingEndpoints()) {
        if (roadNet.getRoadClusterId(ep.gx, ep.gy) === clusterId) {
          anchor = { gx: ep.gx, gy: ep.gy };
          break;
        }
      }
      road.push({
        code: 'road_endpoint_unconnected',
        layer: 'road',
        severity: 'warning',
        gx: anchor?.gx ?? 0,
        gy: anchor?.gy ?? 0,
        title: `Independent road network #${clusterId}`,
        detail: `${info.count} road tiles form a network that does not touch the main road network. Add a connecting road (or a Connector if it crosses into locked land).`,
      });
    }

    // Intersections that look like junctions but have no valid turn geometry.
    for (const [, junction] of roadNet.getAllJunctions()) {
      const node = roadNet.getGraphNode(junction.gx, junction.gy);
      if (!node) continue;
      if (junction.kind === 't_junction' && junction.arms < 3) {
        road.push({
          code: 'intersection_missing',
          layer: 'road',
          severity: 'warning',
          gx: junction.gx,
          gy: junction.gy,
          title: 'Intersection is missing an arm',
          detail: `Tile (${junction.gx}, ${junction.gy}) is registered as a T-junction but only ${junction.arms} arms connect. A road tile on one side is not actually joined.`,
        });
      }
    }

    // ---------------- Layer 2: vehicles -----------------------------------
    for (const v of roadVehicles) {
      const dest = v.destBuildingId ? state.buildings.find((b) => b.id === v.destBuildingId) : undefined;
      const destLabel = dest ? BUILDINGS[dest.defId]?.name ?? `#${dest.id}` : 'loose destination';
      const routeLeft = Math.max(0, v.route.length - v.routeIdx);
      const tx = Math.round(v.gx);
      const ty = Math.round(v.gy);
      const { chunk, index } = chunks.getTile(tx, ty);
      const rt = chunk.roadType[index] as RoadType;
      const onRoad = rt !== RoadType.None && rt !== RoadType.Rail;
      const congested = roadNet.getTileCongestion(tx, ty);

      if (!onRoad) {
        vehicle.push({
          code: 'vehicle_unreachable',
          layer: 'vehicle',
          severity: 'error',
          gx: tx,
          gy: ty,
          vehicleId: v.id,
          title: `${v.kind.replace(/_/g, ' ')} left the road network`,
          detail: `Vehicle #${v.id} is at (${tx}, ${ty}) which has no drivable road. It cannot reach ${destLabel}.`,
        });
        continue;
      }

      if (!isRoadAllowedForVehicle(rt, v.vehicleClass) && v.vehicleClass !== 'emergency') {
        vehicle.push({
          code: 'vehicle_road_unsuitable',
          layer: 'vehicle',
          severity: 'warning',
          gx: tx,
          gy: ty,
          vehicleId: v.id,
          title: `${v.vehicleClass.replace(/_/g, ' ')} on unsuitable road`,
          detail: `Vehicle #${v.id} is on ${ROADS[rt]?.name ?? 'a road'} (max class: ${getRoadProperties(rt).maxVehicleClass}). Route planning will prefer a heavier-duty road next time.`,
        });
      }

      if (v.state === 'idle' && routeLeft === 0) {
        vehicle.push({
          code: 'vehicle_unreachable',
          layer: 'vehicle',
          severity: 'warning',
          gx: tx,
          gy: ty,
          vehicleId: v.id,
          title: `${v.kind.replace(/_/g, ' ')} has no route`,
          detail: `Vehicle #${v.id} cannot find a path to ${destLabel}. ${
            dest ? 'Check that the destination has an adjacent drivable road and that both ends are on the same network.' : ''
          }`,
        });
      }

      if (v.blockedSec > 6) {
        vehicle.push({
          code: 'vehicle_unreachable',
          layer: 'vehicle',
          severity: 'warning',
          gx: tx,
          gy: ty,
          vehicleId: v.id,
          title: `Vehicle #${v.id} is stuck`,
          detail: `Blocked for ${v.blockedSec.toFixed(1)}s on ${ROADS[rt]?.name ?? 'road'} at (${tx}, ${ty}). ${
            v.statusReason ?? ''
          } Congestion here: ${(congested * 100).toFixed(0)}%.`,
        });
      }
    }

    // ---------------- Forestry trucks -------------------------------------
    for (const t of fleet.describeTrucks()) {
      if (t.state === 'blocked' && t.reason) {
        forestry.push({
          code:
            t.failureCode === 'forestry_no_connector'
              ? 'forestry_no_connector'
              : t.failureCode === 'forestry_no_mature_trees'
                ? 'forestry_no_mature_trees'
                : t.failureCode === 'building_no_road_access'
                  ? 'building_no_road_access'
                  : 'vehicle_unreachable',
          layer: 'forestry',
          severity: 'warning',
          gx: Math.round(t.gx),
          gy: Math.round(t.gy),
          vehicleId: t.id,
          title: `Forestry truck #${t.id} is waiting`,
          detail: t.reason,
        });
      }
    }

    // Duplicate forestry jobs: two trucks heading for the same trees.
    const zoneLoads = new Map<string, number[]>();
    for (const t of fleet.describeTrucks()) {
      if (!t.workZoneId) continue;
      const list = zoneLoads.get(t.workZoneId) ?? [];
      list.push(t.id);
      zoneLoads.set(t.workZoneId, list);
    }
    for (const [zoneId, ids] of zoneLoads.entries()) {
      if (ids.length <= 1) continue;
      forestry.push({
        code: 'forestry_duplicate_job',
        layer: 'forestry',
        severity: 'warning',
        gx: 0,
        gy: 0,
        title: `Work zone ${zoneId} has ${ids.length} trucks`,
        detail: `Trucks ${ids.join(', ')} were assigned to the same forest block. The scheduler should assign one truck per block.`,
      });
    }

    // Mature trees that no truck can reach (no locked-area road nearby).
    // One pass over loaded chunks builds the road set, then a cheap 9-tile-radius
    // presence test replaces per-tree tile probing.
    const roadTiles = new Set<string>();
    for (const chunk of chunks.getAllLoadedChunks()) {
      for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++) {
        const rt = chunk.roadType[i] as RoadType;
        if (rt === RoadType.None || rt === RoadType.Rail) continue;
        const gx = chunk.cx * CHUNK_SIZE + (i % CHUNK_SIZE);
        const gy = chunk.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
        roadTiles.add(`${gx}:${gy}`);
      }
    }
    const hasRoadWithin = (gx: number, gy: number, radius: number): boolean => {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (roadTiles.has(`${gx + dx}:${gy + dy}`)) return true;
        }
      }
      return false;
    };

    let unreachableStands = 0;
    for (const chunk of chunks.getAllLoadedChunks()) {
      if (!chunk.isModified) continue;
      for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i += 5) {
        if ((chunk.flags[i] & TileFlag.Unlocked) !== 0) continue;
        const ft = chunk.featureType[i] as FeatureType;
        if (!isTreeFeature(ft)) continue;
        const stage = (chunk.featureStage?.[i] ?? TreeStage.Mature) as TreeStage;
        if (stage !== TreeStage.Mature) continue;
        const { gx, gy } = chunkToGrid(chunk.cx, chunk.cy, i % CHUNK_SIZE, Math.floor(i / CHUNK_SIZE));
        if (hasRoadWithin(gx, gy, 5)) continue;
        unreachableStands++;
        if (unreachableStands <= 3) {
          forestry.push({
            code: 'forestry_no_connector',
            layer: 'forestry',
            severity: 'info',
            gx,
            gy,
            title: 'Mature forest with no road access',
            detail: `Mature trees at (${gx}, ${gy}) have no road within 5 tiles. Forestry trucks cannot work here until a road (and Connector, if locked) reaches them.`,
          });
        }
      }
    }

    // ---------------- Layer 3: utilities ----------------------------------
    for (const issue of UtilityNetworkSystem.diagnoseUtilities(state, chunks)) {
      utility.push({
        code: issue.code,
        layer: 'utility',
        severity: 'warning',
        gx: issue.gx,
        gy: issue.gy,
        title: issue.title,
        detail: `[${issue.kind.toUpperCase()}] ${issue.detail}`,
        buildingId: issue.buildingId,
      });
    }

    // Utility coverage sanity: report tiles whose lines reach no source at all.
    const powerOrphans = state.utilitySummary?.powerDisconnectedTiles ?? 0;
    const waterOrphans = state.utilitySummary?.waterDisconnectedTiles ?? 0;
    if (powerOrphans > 0) {
      utility.push({
        code: 'utility_disconnected',
        layer: 'utility',
        severity: 'info',
        gx: 0,
        gy: 0,
        title: `${powerOrphans} power line tiles reach no generator`,
        detail:
          'These line sections are physically placed but not connected to any power plant or substation. Extend the line or place a substation nearby.',
      });
    }
    if (waterOrphans > 0) {
      utility.push({
        code: 'utility_disconnected',
        layer: 'utility',
        severity: 'info',
        gx: 0,
        gy: 0,
        title: `${waterOrphans} pipe tiles reach no water source`,
        detail: 'These pipe sections are not connected to a water pump or tower.',
      });
    }

    // Buildings whose road access exists but is too low-tier for their freight.
    for (const b of state.buildings) {
      if (b.status === 'constructing') continue;
      const def = BUILDINGS[b.defId];
      if (!def?.requiresRoad) continue;
      const access = roadNet.getCachedRoadAccess(b, chunks);
      if (access.accessPoints.length === 0) continue;
      if (access.heavyTruckSuitable) continue;
      if (def.category === 'industrial' || def.category === 'storage' || def.isLargeFactory) {
        road.push({
          code: 'building_road_tier_too_low',
          layer: 'road',
          severity: 'warning',
          gx: b.gx,
          gy: b.gy,
          buildingId: b.id,
          title: `${def.name} only has narrow road access`,
          detail: `${def.name} at (${b.gx}, ${b.gy}) is served only by narrow streets. Heavy trucks will avoid it, slowing deliveries. Upgrade an adjacent road to Two-Lane or better.`,
        });
      }
    }

    // Deduplicate by code + coordinates + building to keep the panel readable.
    const dedupe = (list: NetworkDiagnosticIssue[]): NetworkDiagnosticIssue[] => {
      const seen = new Set<string>();
      const out: NetworkDiagnosticIssue[] = [];
      for (const item of list) {
        const key = `${item.code}|${item.gx}|${item.gy}|${item.buildingId ?? ''}|${item.vehicleId ?? ''}|${item.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
      return out;
    };

    const snapshot: NetworkDiagnosticsSnapshot = {
      generatedTick: state.tick,
      road: dedupe(road).slice(0, 60),
      utility: dedupe(utility).slice(0, 60),
      vehicle: dedupe(vehicle).slice(0, 60),
      forestry: dedupe(forestry).slice(0, 60),
      counts: {
        roadErrors: road.filter((i) => i.severity === 'error').length,
        utilityErrors: utility.filter((i) => i.severity === 'error').length,
        vehicleErrors: vehicle.filter((i) => i.severity === 'error').length,
        forestryWarnings: forestry.length,
      },
    };
    state.networkDiagnostics = snapshot;
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  /** Focused per-tile explanation used by the tile inspector. */
  public static explainTile(
    gx: number,
    gy: number,
    state: WorldEngineState,
    chunks: ChunkManager,
    roadNet: RoadNetworkSystem
  ): string[] {
    const lines: string[] = [];
    const { chunk, index } = chunks.getTile(gx, gy);
    const rt = chunk.roadType[index] as RoadType;
    if (rt !== RoadType.None) {
      const node = roadNet.getGraphNode(gx, gy);
      const clusterId = roadNet.getRoadClusterId(gx, gy);
      const cluster = roadNet.getClusterInfo(clusterId);
      lines.push(
        `Road: ${ROADS[rt]?.name ?? 'unknown'} · network #${clusterId}${
          cluster?.isMainNetwork ? ' (main)' : ''
        } · ${node?.neighbours.length ?? 0} logical connections`
      );
      if ((node?.neighbours.length ?? 0) === 0) {
        lines.push('This road tile is isolated: no neighbouring road is joined to it.');
      }
      const junction = roadNet.getJunction(gx, gy);
      if (junction) {
        lines.push(
          `Junction: ${junction.kind.replace(/_/g, ' ')} (${junction.arms} arms) · signalized: ${
            junction.signalized ? 'yes' : 'no'
          }`
        );
      }
      if (rt === RoadType.Connector) {
        const status = roadNet.evaluateConnectorStatus(gx, gy, chunks);
        lines.push(`Connector: ${status.statusText}`);
      }
      lines.push(`Traffic load: ${(roadNet.getTileCongestion(gx, gy) * 100).toFixed(0)}%`);
    }

    const u = chunk.utilityNet[index];
    if (u !== 0) {
      const powerMap = UtilityNetworkSystem.buildTileNetworkMap(state, chunks, 'power');
      const waterMap = UtilityNetworkSystem.buildTileNetworkMap(state, chunks, 'water');
      const key = `${gx}:${gy}`;
      const p = powerMap.get(key);
      const w = waterMap.get(key);
      if (p) lines.push(`Power node: network #${p.networkId} · ${p.energized ? 'supplied' : 'NO SUPPLIER'}`);
      if (w) lines.push(`Water node: network #${w.networkId} · ${w.energized ? 'supplied' : 'NO SOURCE'}`);
    }

    const bRef = chunk.buildingRef[index];
    if (bRef >= 0) {
      const b = state.buildings.find((x) => x.id === bRef);
      if (b) {
        const def = BUILDINGS[b.defId];
        const access = roadNet.getCachedRoadAccess(b, chunks);
        lines.push(
          `${def?.name ?? 'Building'}: road ${access.accessPoints.length > 0 ? 'connected' : 'MISSING'} · power ${
            b.powerConnected ? 'ok' : 'MISSING'
          } · water ${b.waterConnected ? 'ok' : 'MISSING'}`
        );
        if (def?.requiresRoad && access.accessPoints.length === 0) {
          const entrances = PathfindingSystem.findBuildingEntrances(b, chunks, 'vehicle');
          lines.push(
            entrances.length > 0
              ? `Adjacent road candidates exist (${entrances.length}) but none are drivable.`
              : 'No drivable road touches this footprint. Place a road on an adjacent tile.'
          );
        }
      }
    }

    const ft = chunk.featureType[index] as FeatureType;
    if (isTreeFeature(ft)) {
      const stage = (chunk.featureStage?.[index] ?? TreeStage.Mature) as TreeStage;
      const stageName = stage === TreeStage.Sapling ? 'sapling' : stage === TreeStage.Young ? 'young' : 'mature';
      const unlocked = (chunk.flags[index] & TileFlag.Unlocked) !== 0;
      lines.push(`Tree: ${stageName} · ${unlocked ? 'owned land (no auto regrowth)' : 'locked land (natural regrowth)'}`);
    }

    return lines;
  }
}
