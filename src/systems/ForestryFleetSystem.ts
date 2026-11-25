import { BUILDINGS, getBuildingFootprint, getBuildingLevelMultiplier } from '../data/buildings.data';
import type { ResourceId } from '../data/resources.data';
import { getRoadProperties, ROADS, RoadType } from '../data/roads.data';
import { FeatureType, isTreeFeature, TREE_SPECIES } from '../data/trees.data';
import type { ChunkManager } from '../core/ChunkManager';
import {
  BuildingInstance,
  FleetSummary,
  ForestryCrewMember,
  ForestryWorkZoneRecord,
  LoggingTruckAgent,
  TileFlag,
  TreeStage,
  WorldEngineState,
} from '../core/GameState';
import { CHUNK_SIZE, chunkToGrid, gridToChunk } from '../core/IsoMath';
import type { ForestrySystem } from './ForestrySystem';
import { PathfindingSystem } from './PathfindingSystem';
import { ResourceSystem } from './ResourceSystem';
import type { RoadNetworkSystem } from './RoadNetworkSystem';

export interface ForestryDeliveryEvent {
  gx: number;
  gy: number;
  label: string;
  color: string;
}

export interface ForestryWorkPlan {
  zoneId?: string;
  zone?: ForestryWorkZoneRecord;
  tree?: { gx: number; gy: number };
  stopRoad?: { gx: number; gy: number };
  entrance?: { gx: number; gy: number };
  path?: Array<{ gx: number; gy: number }>;
  reason?: string;
  failureCode?: string;
}

/** Crew size that rides in a forestry truck (spec: approximately 5-6 workers). */
export const FORESTRY_CREW_SIZE = 6;
/** Hard cap so a trip never exceeds cargo capacity even with generous yields. */
export const FORESTRY_MAX_TREES_PER_TRIP = 40;
/** Minimum meaningful load: never send a truck home after a single tree. */
export const FORESTRY_MIN_TREES_PER_TRIP = 30;
/** Radius around a truck's parking spot in which the crew may work. */
export const FORESTRY_WORK_RADIUS = 7;

const SAWMILL_IDS = new Set(['lumber_mill', 'heavy_lumber_complex', 'sawmill_mega', 'plywood_factory', 'timber_yard']);

function chunkedRng(a: number, b: number, seed: number): number {
  return Math.abs(Math.sin(a * 12.9898 + b * 78.233 + seed * 0.618) * 43758.5453) % 1;
}

/**
 * ForestrySystemFleet owns everything between "the factory wants timber" and
 * "timber is in the factory": work-zone selection, truck scheduling, road
 * routing through Connectors, the 5-6 man crew that actually fells trees, cargo
 * accounting and the loaded/empty visual state.
 *
 * It deliberately reuses:
 *  - RoadNetworkSystem for connectivity (layer 1) and congestion sampling.
 *  - PathfindingSystem for vehicle routing (never teleports, never crosses terrain).
 *  - ForestrySystem for the tree lifecycle (it only *consumes* mature trees).
 *
 * Responsibilities kept strictly separate:
 *  - The truck never cuts trees; only crew members do.
 *  - Cargo capacity is the single authority for how much goes home.
 */
export class ForestryFleetSystem {
  public readonly trucks: LoggingTruckAgent[] = [];
  private nextTruckId = 1;
  private nextCrewId = 1;
  private lastZoneSurveyTick = -9999;
  private lastDeepSurveyTick = -9999;
  /** Trees reserved by any truck/crew so two trucks never harvest the same tree. */
  private reservedTrees = new Set<string>();
  /** Zone ids currently claimed by a truck (one truck per zone cluster). */
  private claimedZones = new Set<string>();
  private harvestedToday = 0;
  private lastDayReset = -1;

  public reset(): void {
    this.trucks.length = 0;
    this.nextTruckId = 1;
    this.nextCrewId = 1;
    this.lastZoneSurveyTick = -9999;
    this.lastDeepSurveyTick = -9999;
    this.reservedTrees.clear();
    this.claimedZones.clear();
    this.harvestedToday = 0;
    this.lastDayReset = -1;
  }

  /** Total cargo capacity of a factory's forestry truck, in timber units. */
  public static getTruckCapacity(factory: BuildingInstance, def: { truckCapacity?: number }): number {
    const base = Math.max(4, def.truckCapacity ?? 6);
    return Math.round(base * 4 * Math.max(1, getBuildingLevelMultiplier(factory.level, BUILDINGS[factory.defId])));
  }

  /** How many trees a full trip should fell (spec: 30-40, capped by cargo). */
  public static getTripTreeTarget(cargoCapacity: number, avgLogsPerTree: number): number {
    const byCapacity = Math.floor(cargoCapacity / Math.max(1, avgLogsPerTree));
    return Math.max(1, Math.min(FORESTRY_MAX_TREES_PER_TRIP, Math.max(FORESTRY_MIN_TREES_PER_TRIP, byCapacity)));
  }

  public getFleetSummary(factoryId: number, state: WorldEngineState): FleetSummary {
    const mine = this.trucks.filter((t) => t.factoryId === factoryId);
    const summary: FleetSummary = {
      total: mine.length,
      available: 0,
      active: 0,
      cargo: 0,
      waiting: 0,
      returning: 0,
      blocked: 0,
      destinations: [],
    };
    const destSet = new Set<string>();
    for (const t of mine) {
      switch (t.state) {
        case 'idle_at_factory':
        case 'unloading':
          summary.available++;
          break;
        case 'to_forest':
        case 'to_pickup':
        case 'crew_working':
        case 'stockpiling':
          summary.active++;
          break;
        case 'to_factory':
          summary.returning++;
          break;
        case 'blocked':
          summary.blocked++;
          summary.waiting++;
          break;
      }
      if (t.cargoTimber > 0) summary.cargo++;
      if (t.workZoneId) {
        const zone = state.forestryWorkZones?.find((z) => z.id === t.workZoneId);
        const label = zone ? `Zone ${zone.id}` : 'Forest site';
        destSet.add(label);
      } else if (t.state === 'to_factory') {
        destSet.add('Factory');
      }
    }
    summary.destinations = Array.from(destSet).slice(0, 6);
    return summary;
  }

  /**
   * Maintains exactly one truck per configured fleet slot, and prunes trucks for
   * demolised/disabled factories. Trucks are created parked at a factory entrance.
   */
  public syncFleets(state: WorldEngineState, chunks: ChunkManager, roadNet: RoadNetworkSystem): void {
    const factories = state.buildings.filter((b) => {
      const def = BUILDINGS[b.defId];
      return def?.isAutomatedLogging && b.status !== 'constructing' && b.enabled;
    });

    const activeIds = new Set(factories.map((f) => f.id));
    for (let i = this.trucks.length - 1; i >= 0; i--) {
      const t = this.trucks[i];
      if (!activeIds.has(t.factoryId)) {
        this.releaseReservation(t);
        this.claimedZones.delete(t.workZoneId ?? '');
        this.trucks.splice(i, 1);
      }
    }

    for (const factory of factories) {
      const def = BUILDINGS[factory.defId]!;
      const fp = getBuildingFootprint(def, factory.rotation ?? 0);
      const cx = factory.gx + fp.width * 0.5;
      const cy = factory.gy + fp.height * 0.5;
      const entrances = PathfindingSystem.findBuildingEntrances(factory, chunks, 'vehicle');
      const spawn = entrances[0] ?? { gx: cx, gy: cy };
      const cargoCapacity = ForestryFleetSystem.getTruckCapacity(factory, def);
      const targetTrucks = Math.max(1, def.truckCapacity ?? 10);

      let existing = this.trucks.filter((t) => t.factoryId === factory.id);
      while (existing.length < targetTrucks) {
        const truck: LoggingTruckAgent = {
          id: this.nextTruckId++,
          factoryId: factory.id,
          gx: spawn.gx,
          gy: spawn.gy,
          targetGx: spawn.gx,
          targetGy: spawn.gy,
          state: 'idle_at_factory',
          cargoTimber: 0,
          cargoCapacity,
          tripTargetTrees: FORESTRY_MIN_TREES_PER_TRIP,
          treesFelledThisTrip: 0,
          harvestTimer: 0.25 + (existing.length % 5) * 0.3,
          facing: 1,
          route: undefined,
          routeIdx: 0,
          routeVersion: roadNet.networkVersion,
          laneOffset: 0,
          vx: 0,
          vy: 0,
          onRoad: entrances.length > 0,
          crew: this.createCrew(),
          statusReason: entrances.length > 0 ? 'Ready for dispatch' : 'Blocked: connect a road to the factory',
          failureCode: entrances.length > 0 ? undefined : 'building_no_road_access',
        };
        this.trucks.push(truck);
        existing.push(truck);
      }
      if (existing.length > targetTrucks) {
        const removed = existing.slice(targetTrucks);
        for (const r of removed) {
          this.releaseReservation(r);
          const idx = this.trucks.indexOf(r);
          if (idx >= 0) this.trucks.splice(idx, 1);
        }
        existing = existing.slice(0, targetTrucks);
      }
      for (const t of existing) {
        t.cargoCapacity = cargoCapacity;
      }

      // Compute a per-building fleet summary for the UI.
      factory.fleet = this.getFleetSummary(factory.id, state);
    }
  }

  private createCrew(): ForestryCrewMember[] {
    const crew: ForestryCrewMember[] = [];
    for (let i = 0; i < FORESTRY_CREW_SIZE; i++) {
      crew.push({
        id: this.nextCrewId++,
        gx: 0,
        gy: 0,
        phase: 'in_truck',
        targetGx: 0,
        targetGy: 0,
        reservedTreeGx: -1,
        reservedTreeGy: -1,
        carryingLogs: 0,
        facing: 1,
        chopTimer: 0,
        treesFelled: 0,
      });
    }
    return crew;
  }

  /**
   * Rebuilds the reservation set from what live trucks and crews actually hold.
   * Reservations used to leak whenever a trip was abandoned, which eventually made
   * the whole forest look "culled" and stalled the fleet permanently.
   */
  private rebuildReservations(): void {
    this.reservedTrees.clear();
    this.claimedZones.clear();
    for (const truck of this.trucks) {
      if (truck.reservedTreeGx !== undefined && truck.reservedTreeGy !== undefined) {
        this.reservedTrees.add(`${truck.reservedTreeGx}:${truck.reservedTreeGy}`);
      }
      if (truck.workZoneId) this.claimedZones.add(truck.workZoneId);
      for (const c of truck.crew ?? []) {
        if (c.reservedTreeGx >= 0) this.reservedTrees.add(`${c.reservedTreeGx}:${c.reservedTreeGy}`);
      }
    }
  }

  private releaseReservation(truck: LoggingTruckAgent): void {
    if (truck.reservedTreeGx !== undefined && truck.reservedTreeGy !== undefined) {
      this.reservedTrees.delete(`${truck.reservedTreeGx}:${truck.reservedTreeGy}`);
    }
    truck.reservedTreeGx = undefined;
    truck.reservedTreeGy = undefined;
    for (const c of truck.crew ?? []) {
      if (c.reservedTreeGx >= 0) this.reservedTrees.delete(`${c.reservedTreeGx}:${c.reservedTreeGy}`);
      c.reservedTreeGx = -1;
      c.reservedTreeGy = -1;
      c.phase = 'in_truck';
      c.carryingLogs = 0;
    }
  }

  // ===========================================================================
  // Work-zone management
  // ===========================================================================

  /**
   * Surveys locked-area forest blocks and refreshes the persisted work-zone
   * ledger. Each zone tracks how many mature trees it holds, so trucks are never
   * sent back to a stripped area.
   */
  public surveyWorkZones(state: WorldEngineState, chunks: ChunkManager, roadNet: RoadNetworkSystem): void {
    if (state.tick - this.lastZoneSurveyTick < 25) return;
    this.lastZoneSurveyTick = state.tick;
    // A full survey is a whole-world scan: keep it on a slow cadence.
    if (state.tick - this.lastDeepSurveyTick < 400 && (state.forestryWorkZones?.length ?? 0) > 0) return;
    this.lastDeepSurveyTick = state.tick;
    state.forestryWorkZones ??= [];
    if (state.forestryWorkZones.length > 0) {
      this.lastDeepSurveyTick = state.tick;
    }

    interface Bucket {
      /** Centroid of reachable trees only (this becomes the zone anchor). */
      sumX: number;
      sumY: number;
      count: number;
      mature: number;
    }
    const buckets = new Map<string, Bucket>();
    const zoneSize = 8;

    // Road presence index: a zone only matters when a truck can physically park
    // within FORESTRY_WORK_RADIUS of it. Zones with no road are never recorded, so
    // trucks are not dispatched to unreachable forest and then reported "blocked".
    const drivableRoads = new Set<string>();
    for (const chunk of chunks.getAllLoadedChunks()) {
      for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++) {
        const rt = chunk.roadType[i] as RoadType;
        if (rt === RoadType.None || rt === RoadType.Rail) continue;
        const gx = chunk.cx * CHUNK_SIZE + (i % CHUNK_SIZE);
        const gy = chunk.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
        drivableRoads.add(`${gx}:${gy}`);
      }
    }
    /**
     * A zone is only recorded when a *real network* runs within work radius.
     * A lone road stub is not access: the truck could park on it but could never
     * get there, which previously produced "blocked: no valid road route" trips.
     */
    const hasRoadNear = (gx: number, gy: number): boolean => {
      for (let dy = -FORESTRY_WORK_RADIUS; dy <= FORESTRY_WORK_RADIUS; dy++) {
        for (let dx = -FORESTRY_WORK_RADIUS; dx <= FORESTRY_WORK_RADIUS; dx++) {
          if (Math.abs(dx) + Math.abs(dy) > FORESTRY_WORK_RADIUS) continue;
          const key = `${gx + dx}:${gy + dy}`;
          if (!drivableRoads.has(key)) continue;
          const clusterId = roadNet.getRoadClusterId(gx + dx, gy + dy);
          if (clusterId === 0) continue;
          const info = roadNet.getClusterInfo(clusterId);
          // Require a genuine network (>= 3 linked tiles), not an isolated stub.
          if ((info?.count ?? 0) >= 3) return true;
        }
      }
      return false;
    };

    for (const chunk of chunks.getAllLoadedChunks()) {
      if (!chunk.isModified) continue;
      for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++) {
        if ((chunk.flags[i] & TileFlag.Unlocked) !== 0) continue; // locked land only
        const ft = chunk.featureType[i] as FeatureType;
        if (!isTreeFeature(ft)) continue;
        const stage = (chunk.featureStage?.[i] ?? TreeStage.Mature) as TreeStage;
        if (stage !== TreeStage.Mature) continue;
        const { gx, gy } = chunkToGrid(chunk.cx, chunk.cy, i % CHUNK_SIZE, Math.floor(i / CHUNK_SIZE));
        const key = `${Math.floor(gx / zoneSize)}:${Math.floor(gy / zoneSize)}`;
        // Only trees a truck can actually park beside count toward the anchor.
        // Anchoring on the whole block (including trees deep in the forest, out of
        // reach of any road) is what made a zone look valid but have no parking.
        if (!hasRoadNear(gx, gy)) continue;
        let b = buckets.get(key);
        if (!b) {
          b = { sumX: 0, sumY: 0, count: 0, mature: 0 };
          buckets.set(key, b);
        }
        b.sumX += gx;
        b.sumY += gy;
        b.count++;
        b.mature++;
      }
    }

    for (const [id, b] of buckets.entries()) {
      const existing = state.forestryWorkZones.find((z) => z.id === id);
      const anchorGx = Math.round(b.sumX / Math.max(1, b.count));
      const anchorGy = Math.round(b.sumY / Math.max(1, b.count));
      if (existing) {
        existing.gx = anchorGx;
        existing.gy = anchorGy;
        existing.matureTrees = b.mature;
      } else {
        state.forestryWorkZones.push({
          id,
          gx: anchorGx,
          gy: anchorGy,
          lastHarvestTick: -9999,
          matureTrees: b.mature,
          harvestedTotal: 0,
          cooldownUntilTick: 0,
        });
      }
    }

    // Drop zones that no longer contain mature trees and are not being worked.
    state.forestryWorkZones = state.forestryWorkZones.filter(
      (z) => z.matureTrees > 0 || this.claimedZones.has(z.id) || state.tick - z.lastHarvestTick < 400
    );
    void roadNet;
  }

  /** Chooses the best locked-area forest block for a factory, or explains why not. */
  public selectWorkZone(
    factory: BuildingInstance,
    state: WorldEngineState,
    chunks: ChunkManager,
    roadNet: RoadNetworkSystem,
    truck: LoggingTruckAgent
  ): { zone?: ForestryWorkZoneRecord; plan?: ForestryWorkPlan; reason?: string; failureCode?: string } {
    state.forestryWorkZones ??= [];
    const def = BUILDINGS[factory.defId];
    const fp = def ? getBuildingFootprint(def, factory.rotation ?? 0) : { width: 3, height: 3 };
    const fx = factory.gx + fp.width * 0.5;
    const fy = factory.gy + fp.height * 0.5;

    if ((roadNet.getActiveConnectors?.() ?? []).filter((c) => c.bridgesOwned && c.bridgesLocked).length === 0) {
      // No working Connector: a truck cannot leave the owned network at all.
      const anyLockedRoad = this.hasLockedRoadNear(state, chunks, fx, fy, 40);
      if (anyLockedRoad) {
        return {
          reason: 'Blocked: place a Road Connector linking an owned road to the locked-area road',
          failureCode: 'forestry_no_connector',
        };
      }
    }

    const congestion = roadNet.getTileCongestionMap();
    const candidates: Array<{ zone: ForestryWorkZoneRecord; score: number }> = [];
    let claimedByOthers = 0;
    for (const zone of state.forestryWorkZones) {
      if (zone.matureTrees <= 0) continue;
      if (zone.cooldownUntilTick > state.tick) continue;
      // Never assign two trucks to the same block of trees.
      if (this.claimedZones.has(zone.id) && truck.workZoneId !== zone.id) {
        claimedByOthers++;
        continue;
      }
      const dist = Math.hypot(zone.gx - fx, zone.gy - fy);
      const density = Math.min(3, zone.matureTrees / 10);
      const score = dist - density * 6 + (state.tick - zone.lastHarvestTick < 120 ? 25 : 0);
      void congestion;
      candidates.push({ zone, score });
    }
    candidates.sort((a, b) => a.score - b.score);

    // Probe candidates until one yields a real, routable parking spot. The plan is
    // returned so dispatch uses exactly the decision that was validated here —
    // re-probing risked approving a zone and then failing to route to it.
    for (const cand of candidates.slice(0, 6)) {
      const probe = this.findHarvestSite(factory, cand.zone, chunks, roadNet, truck);
      if (probe.tree && probe.stopRoad && probe.entrance) {
        return { zone: cand.zone, plan: probe };
      }
    }

    // Every usable block is already being worked by another truck: wait rather
    // than reporting a misleading routing error.
    if (claimedByOthers > 0 && candidates.length === 0) {
      return {
        reason: `Waiting: ${claimedByOthers} forest block${claimedByOthers === 1 ? ' is' : 's are'} already being harvested by another truck`,
        failureCode: undefined,
      };
    }
    if (candidates.length > 0) {
      // Zones exist but none is routable right now (depleted parking area, road
      // removed, or a Connector disconnected). Say which, precisely.
      const connectors = (roadNet.getActiveConnectors?.() ?? []).filter((c) => c.bridgesOwned && c.bridgesLocked);
      return {
        reason:
          connectors.length === 0
            ? 'Waiting: no Road Connector bridges the owned network to the forest roads'
            : 'Waiting: forest roads exist near these trees but none is reachable from the factory',
        failureCode: connectors.length === 0 ? 'forestry_no_connector' : 'vehicle_unreachable',
      };
    }

    // No ledger zone worked out: fall back to a direct scan so a fresh save with
    // pre-existing forests still dispatches trucks immediately.
    const direct = this.scanForForestSite(factory, chunks, roadNet, truck);
    if (direct.zone && direct.tree && direct.stopRoad && direct.entrance) {
      return { zone: direct.zone, plan: direct };
    }
    return {
      reason: direct.reason ?? 'Waiting for mature trees to regenerate',
      failureCode: direct.failureCode,
    };
  }

  private hasLockedRoadNear(state: WorldEngineState, chunks: ChunkManager, fx: number, fy: number, radius: number): boolean {
    void state;
    const r = Math.min(radius, 30);
    for (let dy = -r; dy <= r; dy += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
        const gx = Math.round(fx) + dx;
        const gy = Math.round(fy) + dy;
        if (chunks.isUnlocked(gx, gy)) continue;
        const { chunk, index } = chunks.getTile(gx, gy);
        const rt = chunk.roadType[index] as RoadType;
        if (rt !== RoadType.None && rt !== RoadType.Rail) return true;
      }
    }
    return false;
  }

  /** Builds a synthetic zone from a live scan (used before the ledger warms up). */
  private scanForForestSite(
    factory: BuildingInstance,
    chunks: ChunkManager,
    roadNet: RoadNetworkSystem,
    truck: LoggingTruckAgent
  ): ForestryWorkPlan {
    const def = BUILDINGS[factory.defId];
    const fp = def ? getBuildingFootprint(def, factory.rotation ?? 0) : { width: 3, height: 3 };
    const fx = factory.gx + fp.width * 0.5;
    const fy = factory.gy + fp.height * 0.5;
    let best: { gx: number; gy: number; count: number; dist: number } | null = null;

    for (const chunk of chunks.getAllLoadedChunks()) {
      if (!chunk.isModified) continue;
      for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++) {
        if ((chunk.flags[i] & TileFlag.Unlocked) !== 0) continue;
        const ft = chunk.featureType[i] as FeatureType;
        if (!isTreeFeature(ft)) continue;
        const stage = (chunk.featureStage?.[i] ?? TreeStage.Mature) as TreeStage;
        if (stage !== TreeStage.Mature) continue;
        const { gx, gy } = chunkToGrid(chunk.cx, chunk.cy, i % CHUNK_SIZE, Math.floor(i / CHUNK_SIZE));
        const dist = Math.hypot(gx - fx, gy - fy);
        if (!best || dist < best.dist) best = { gx, gy, count: 1, dist };
      }
    }

    if (!best) {
      return { reason: 'Waiting for mature trees on locked land', failureCode: 'forestry_no_mature_trees' };
    }
    // Build a transient zone record around the found stand.
    const zone: ForestryWorkZoneRecord = {
      id: `scan_${Math.floor(best.gx / 8)}:${Math.floor(best.gy / 8)}`,
      gx: best.gx,
      gy: best.gy,
      lastHarvestTick: -9999,
      matureTrees: 1,
      harvestedTotal: 0,
      cooldownUntilTick: 0,
    };
    const site = this.findHarvestSite(factory, zone, chunks, roadNet, truck);
    if (site.tree) return { zone, tree: site.tree, stopRoad: site.stopRoad, entrance: site.entrance, path: site.path };
    return {
      reason: site.reason ?? 'No road route into that forest block',
      failureCode: site.failureCode ?? 'vehicle_unreachable',
    };
  }

  /**
   * Finds a parking spot on the reachable locked-area road network plus the trees
   * the crew should walk to. Uses the same vehicle pathfinder as every other
   * system, and searches **road-first**: candidates come from the road graph, so a
   * returned plan is guaranteed to be drivable. Searching tree-first could pick a
   * spot that looked close but sat on a stub the truck could never reach.
   */
  public findHarvestSite(
    factory: BuildingInstance,
    zone: ForestryWorkZoneRecord,
    chunks: ChunkManager,
    roadNet: RoadNetworkSystem,
    truck: LoggingTruckAgent
  ): ForestryWorkPlan {
    const roads = roadNet.getCachedRoadAccess(factory, chunks);
    const entrances = roads.accessPoints.length > 0
      ? roads.accessPoints.map((a) => ({ gx: a.gx, gy: a.gy }))
      : PathfindingSystem.findBuildingEntrances(factory, chunks, 'vehicle');
    if (entrances.length === 0) {
      return { reason: 'Blocked: connect a drivable road to the Logging Factory', failureCode: 'building_no_road_access' };
    }

    const congestion = roadNet.getTileCongestionMap();
    const pathOpts = { vehicleClass: 'heavy_truck' as const, congestionMap: congestion };

    // Parking spots are any drivable road tile within reach of the trees. Crews can
    // walk from an owned road into adjacent locked forest, so restricting parking
    // to locked-area roads needlessly reported "no route" for border forests.
    // Spots on locked roads are still preferred because they sit closer to the
    // trees and keep heavy trucks off residential streets.
    const candidates: Array<{ gx: number; gy: number; dist: number; onLocked: boolean }> = [];
    const seen = new Set<string>();
    const maxRadius = 16;
    for (const clusterId of roadNet.getDrivableClusterIds()) {
      for (const node of roadNet.getClusterNodes(clusterId)) {
        const key = `${node.gx}:${node.gy}`;
        if (seen.has(key)) continue;
        const dist = Math.hypot(node.gx - zone.gx, node.gy - zone.gy);
        if (dist > maxRadius + FORESTRY_WORK_RADIUS) continue;
        if (this.parkingSpotTakenBy(node.gx, node.gy, truck.id)) continue;
        if (!PathfindingSystem.isTilePassable(node.gx, node.gy, chunks, 'vehicle')) continue;
        seen.add(key);
        candidates.push({ gx: node.gx, gy: node.gy, dist, onLocked: !node.unlocked });
      }
    }
    if (candidates.length === 0) {
      return {
        reason: 'Blocked: no reachable locked-area road near these trees. Extend the Connector or build forest roads.',
        failureCode: 'forestry_no_connector',
      };
    }
    candidates.sort((a, b) => a.dist - b.dist - (a.onLocked ? 4 : 0) + (b.onLocked ? 4 : 0));

    // Trees within the crew's walking radius of each candidate spot.
    const collectTrees = (gx: number, gy: number): Array<{ gx: number; gy: number; dist: number }> => {
      const found: Array<{ gx: number; gy: number; dist: number }> = [];
      for (let dy = -FORESTRY_WORK_RADIUS; dy <= FORESTRY_WORK_RADIUS; dy++) {
        for (let dx = -FORESTRY_WORK_RADIUS; dx <= FORESTRY_WORK_RADIUS; dx++) {
          if (Math.abs(dx) + Math.abs(dy) > FORESTRY_WORK_RADIUS) continue;
          const tx = gx + dx;
          const ty = gy + dy;
          if (this.reservedTrees.has(`${tx}:${ty}`)) continue;
          if (chunks.isUnlocked(tx, ty)) continue; // locked land only
          const { chunk, index } = chunks.getTile(tx, ty);
          const ft = chunk.featureType[index] as FeatureType;
          if (!isTreeFeature(ft)) continue;
          const stage = (chunk.featureStage?.[index] ?? TreeStage.Mature) as TreeStage;
          if (stage !== TreeStage.Mature) continue;
          found.push({ gx: tx, gy: ty, dist: Math.abs(dx) + Math.abs(dy) });
        }
      }
      found.sort((a, b) => a.dist - b.dist);
      return found;
    };

    // Only probe spots that actually have trees the crew can reach.
    const viable = candidates
      .map((c) => ({ ...c, trees: collectTrees(c.gx, c.gy) }))
      .filter((c) => c.trees.length > 0);
    if (viable.length === 0) {
      return { reason: 'No mature trees left at this location', failureCode: 'forestry_no_mature_trees' };
    }
    // Rank by tree density then distance: a spot with more nearby trees beats a
    // marginally closer one with a single trunk.
    viable.sort((a, b) => b.trees.length * 2 - a.trees.length * 2 + (a.dist - b.dist) * 0.5);

    for (const spot of viable.slice(0, 8)) {
      for (const ent of entrances.slice(0, 2)) {
        if (ent.gx === spot.gx && ent.gy === spot.gy) {
          return { zone, tree: spot.trees[0], stopRoad: { gx: spot.gx, gy: spot.gy }, entrance: ent, path: [] };
        }
        const path = PathfindingSystem.findPath(
          ent.gx,
          ent.gy,
          spot.gx,
          spot.gy,
          chunks,
          'vehicle',
          520,
          pathOpts
        );
        if (path && path.length > 0) {
          return { zone, tree: spot.trees[0], stopRoad: { gx: spot.gx, gy: spot.gy }, entrance: ent, path };
        }
      }
    }

    return {
      reason: 'No valid road route to the forest site. Check the Connector and road continuity.',
      failureCode: 'vehicle_unreachable',
    };
  }

  /** True when another truck already parked on (or claimed) this exact tile. */
  private parkingSpotTakenBy(gx: number, gy: number, exceptTruckId: number): boolean {
    for (const t of this.trucks) {
      if (t.id === exceptTruckId) continue;
      if (t.state === 'crew_working' || t.state === 'stockpiling') {
        if (Math.round(t.gx) === gx && Math.round(t.gy) === gy) return true;
      }
    }
    return false;
  }

  // ===========================================================================
  // Scheduling
  // ===========================================================================

  /**
   * Dispatch decision. A truck only leaves when there is real work: mature trees
   * it can reach, spare cargo space, and a valid route. Everything else is
   * reported through `statusReason`/`failureCode` for the diagnostics tool.
   */
  private tryDispatch(
    truck: LoggingTruckAgent,
    factory: BuildingInstance,
    state: WorldEngineState,
    chunks: ChunkManager,
    roadNet: RoadNetworkSystem
  ): void {
    const def = BUILDINGS[factory.defId];
    if (!def) return;

    const cargoCapacity = truck.cargoCapacity ?? ForestryFleetSystem.getTruckCapacity(factory, def);
    // Average logs per tree from the local species mix keeps targets honest.
    const avgLogs = 8;
    // Spec: a normal trip fells ~30-40 trees, capped by what the truck can hold.
    // The target is never reduced to squeeze more trucks into the same block —
    // zone claiming is what prevents overlap, and a depleted site simply ends the
    // trip early with whatever was loaded.
    const treeTarget = ForestryFleetSystem.getTripTreeTarget(cargoCapacity, avgLogs);
    truck.tripTargetTrees = treeTarget;
    truck.treesFelledThisTrip = 0;

    // Prevent pointless trips: if the factory already holds plenty of timber and
    // storage is nearly full, wait instead of harvesting more.
    const woodNow = state.resources.wood ?? 0;
    const woodCap = state.capacities.wood ?? 0;
    if (woodCap > 0 && woodNow >= woodCap * 0.98) {
      truck.state = 'blocked';
      truck.harvestTimer = 4.0;
      truck.statusReason = 'Waiting: factory timber storage is full';
      truck.failureCode = undefined;
      return;
    }

    const selection = this.selectWorkZone(factory, state, chunks, roadNet, truck);
    if (!selection.zone) {
      truck.state = 'blocked';
      truck.harvestTimer = 3.0;
      truck.statusReason = selection.reason ?? 'Blocked: no forest work available';
      truck.failureCode = selection.failureCode;
      return;
    }

    const zone = selection.zone;
    const plan = selection.plan ?? this.findHarvestSite(factory, zone, chunks, roadNet, truck);
    if (!plan.tree || !plan.stopRoad || !plan.entrance) {
      truck.state = 'blocked';
      truck.harvestTimer = 3.0;
      truck.statusReason = plan.reason ?? 'Blocked: no reachable forest site';
      truck.failureCode = plan.failureCode;
      return;
    }

    // Claim the zone so no other truck drives to the same block of trees.
    if (truck.workZoneId && truck.workZoneId !== zone.id) this.claimedZones.delete(truck.workZoneId);
    truck.workZoneId = zone.id;
    this.claimedZones.add(zone.id);

    // Reserve the tree the crew will fell first, so two trucks never queue for
    // the same trunk even before their crews arrive.
    if (plan.tree) {
      truck.reservedTreeGx = plan.tree.gx;
      truck.reservedTreeGy = plan.tree.gy;
      this.reservedTrees.add(`${plan.tree.gx}:${plan.tree.gy}`);
    }
    truck.stopRoadGx = plan.stopRoad.gx;
    truck.stopRoadGy = plan.stopRoad.gy;
    truck.targetGx = plan.stopRoad.gx;
    truck.targetGy = plan.stopRoad.gy;
    truck.gx = plan.entrance.gx;
    truck.gy = plan.entrance.gy;
    truck.onRoad = true;
    truck.route = plan.path ?? [];
    truck.routeIdx = 0;
    truck.routeVersion = roadNet.networkVersion;
    truck.state = 'to_forest';
    truck.failureCode = undefined;
    truck.statusReason = 'Driving to locked-area harvest site';
    for (const c of truck.crew ?? []) {
      c.phase = 'in_truck';
      c.gx = truck.gx;
      c.gy = truck.gy;
      c.carryingLogs = 0;
    }
  }

  // ===========================================================================
  // Simulation step
  // ===========================================================================

  public update(
    dtSec: number,
    state: WorldEngineState,
    chunks: ChunkManager,
    roadNet: RoadNetworkSystem,
    forestry: ForestrySystem,
    onEvent?: (ev: ForestryDeliveryEvent) => void
  ): void {
    const dayKey = state.year * 100 + state.dayInSeason;
    if (this.lastDayReset !== dayKey) {
      this.lastDayReset = dayKey;
      this.harvestedToday = 0;
    }
    if (this.trucks.length === 0) {
      this.updateLoggingStats(state, chunks);
      return;
    }

    // Reservations are derived state: rebuild them from the live fleet so an
    // abandoned trip can never permanently reserve a tree or a work zone.
    if (state.tick % 15 === 0) this.rebuildReservations();

    const factoryCache = new Map<number, BuildingInstance | undefined>();
    for (const truck of this.trucks) {
      let factory = factoryCache.get(truck.factoryId);
      if (factory === undefined && !factoryCache.has(truck.factoryId)) {
        factory = state.buildings.find((b) => b.id === truck.factoryId);
        factoryCache.set(truck.factoryId, factory);
      }
      if (!factory || !factory.enabled) continue;
      this.stepTruck(truck, factory, dtSec, state, chunks, roadNet, forestry, onEvent);
    }

    this.updateLoggingStats(state, chunks);
  }

  private updateLoggingStats(state: WorldEngineState, chunks: ChunkManager): void {
    state.loggingStats ??= {
      harvestedTrees: 0,
      factoryTimberStock: 0,
      dailyTimberProduction: 0,
      activeTrucks: 0,
      permittedForestTiles: 0,
    };
    state.loggingStats.activeTrucks = this.trucks.filter(
      (t) => t.state === 'to_forest' || t.state === 'to_factory' || t.state === 'crew_working'
    ).length;
    state.loggingStats.permittedForestTiles = chunks.countLoggingPermittedTiles();
    state.loggingStats.factoryTimberStock = Math.round(state.resources.wood ?? 0);
    state.loggingStats.dailyTimberProduction = this.harvestedToday;
  }

  private stepTruck(
    truck: LoggingTruckAgent,
    factory: BuildingInstance,
    dtSec: number,
    state: WorldEngineState,
    chunks: ChunkManager,
    roadNet: RoadNetworkSystem,
    forestry: ForestrySystem,
    onEvent?: (ev: ForestryDeliveryEvent) => void
  ): void {
    const def = BUILDINGS[factory.defId];
    if (!def) return;
    const fp = getBuildingFootprint(def, factory.rotation ?? 0);
    const homeGx = factory.gx + fp.width * 0.5;
    const homeGy = factory.gy + fp.height * 0.5;
    const cargoCapacity = truck.cargoCapacity ?? ForestryFleetSystem.getTruckCapacity(factory, def);
    const workerRatio = Math.max(0.2, Math.min(1.2, (factory.assignedWorkers || 1) / Math.max(1, def.maxWorkers)));
    const driveSpeed = 2.1 * (0.7 + workerRatio * 0.55);

    switch (truck.state) {
      case 'idle_at_factory':
      case 'unloading': {
        truck.harvestTimer -= dtSec;
        if (truck.harvestTimer > 0) return;
        this.tryDispatch(truck, factory, state, chunks, roadNet);
        return;
      }

      case 'blocked': {
        truck.harvestTimer -= dtSec;
        if (truck.harvestTimer > 0) return;
        // Retry a recovery route home first when carrying timber.
        if (truck.cargoTimber > 0) {
          const back = this.routeBackToFactory(truck, factory, chunks, roadNet);
          if (back) {
            truck.state = 'to_factory';
            truck.statusReason = 'Recovered route back to factory';
            return;
          }
        }
        this.tryDispatch(truck, factory, state, chunks, roadNet);
        return;
      }

      case 'to_forest':
      case 'to_factory': {
        const arrived = this.driveAlongRoute(truck, dtSec, driveSpeed, chunks, roadNet);
        if (!arrived) return;

        if (truck.state === 'to_forest') {
          truck.state = 'crew_working';
          truck.harvestTimer = 0;
          truck.statusReason = 'Crew disembarking to fell timber';
          this.deployCrew(truck, chunks);
          return;
        }

        // Arrived home: unload.
        this.unloadAtFactory(truck, factory, state, onEvent, homeGx, homeGy);
        return;
      }

      case 'crew_working': {
        this.stepCrew(truck, factory, dtSec, state, chunks, forestry, onEvent);
        return;
      }

      case 'stockpiling': {
        truck.harvestTimer -= dtSec;
        if (truck.harvestTimer > 0) return;
        const back = this.routeBackToFactory(truck, factory, chunks, roadNet);
        if (back) {
          truck.state = 'to_factory';
          truck.statusReason = 'Returning loaded to factory';
          truck.targetGx = homeGx;
          truck.targetGy = homeGy;
        } else {
          truck.state = 'blocked';
          truck.harvestTimer = 2.0;
          truck.statusReason = 'Blocked: no road route back to factory';
          truck.failureCode = 'vehicle_unreachable';
        }
        return;
      }

      case 'to_pickup':
      default: {
        truck.state = 'idle_at_factory';
        truck.harvestTimer = 0.5;
        return;
      }
    }
  }

  private routeBackToFactory(
    truck: LoggingTruckAgent,
    factory: BuildingInstance,
    chunks: ChunkManager,
    roadNet: RoadNetworkSystem
  ): boolean {
    const startX = Math.round(truck.gx);
    const startY = Math.round(truck.gy);
    const congestion = roadNet.getTileCongestionMap();
    const entrances = PathfindingSystem.findBuildingEntrances(factory, chunks, 'vehicle');
    for (const ent of entrances.slice(0, 4)) {
      if (ent.gx === startX && ent.gy === startY) {
        truck.route = [];
        truck.routeIdx = 0;
        truck.routeVersion = roadNet.networkVersion;
        return true;
      }
      const path = PathfindingSystem.findPath(startX, startY, ent.gx, ent.gy, chunks, 'vehicle', 520, {
        vehicleClass: 'heavy_truck',
        congestionMap: congestion,
      });
      if (path && path.length > 0) {
        truck.route = path;
        truck.routeIdx = 0;
        truck.routeVersion = roadNet.networkVersion;
        return true;
      }
    }
    return false;
  }

  /** Road-following movement. Returns true when the final waypoint is reached. */
  private driveAlongRoute(
    truck: LoggingTruckAgent,
    dtSec: number,
    speed: number,
    chunks: ChunkManager,
    roadNet: RoadNetworkSystem
  ): boolean {
    if (roadNet.networkVersion !== truck.routeVersion) {
      // Network changed under us: re-validate the remaining waypoints.
      const route = truck.route ?? [];
      let intact = true;
      let px = Math.round(truck.gx);
      let py = Math.round(truck.gy);
      for (let i = truck.routeIdx ?? 0; i < route.length; i++) {
        const wp = route[i];
        if (!PathfindingSystem.isEdgeTraversable(px, py, wp.gx, wp.gy, chunks, 'vehicle')) {
          intact = false;
          break;
        }
        px = wp.gx;
        py = wp.gy;
      }
      truck.routeVersion = roadNet.networkVersion;
      if (!intact) {
        truck.route = undefined;
        truck.state = 'blocked';
        truck.harvestTimer = 1.5;
        truck.statusReason = 'Blocked: road network changed underneath the truck';
        truck.failureCode = 'vehicle_unreachable';
        return false;
      }
    }

    const route = truck.route ?? [];
    if ((truck.routeIdx ?? 0) >= route.length) return true;

    let budget = speed * dtSec;
    while (budget > 0 && (truck.routeIdx ?? 0) < route.length) {
      const wp = route[truck.routeIdx ?? 0];
      const dx = wp.gx - truck.gx;
      const dy = wp.gy - truck.gy;
      const dist = Math.hypot(dx, dy);
      if (dist <= budget) {
        truck.gx = wp.gx;
        truck.gy = wp.gy;
        budget -= dist;
        truck.routeIdx = (truck.routeIdx ?? 0) + 1;
        truck.vx = dx;
        truck.vy = dy;
        if (dist > 0.001) truck.facing = dx - dy >= 0 ? 1 : -1;
      } else {
        truck.gx += (dx / dist) * budget;
        truck.gy += (dy / dist) * budget;
        truck.vx = dx / dist;
        truck.vy = dy / dist;
        truck.facing = dx - dy >= 0 ? 1 : -1;
        budget = 0;
      }
      const tgx = Math.round(truck.gx);
      const tgy = Math.round(truck.gy);
      truck.onRoad = PathfindingSystem.isTilePassable(tgx, tgy, chunks, 'vehicle');
      const { chunk, index } = chunks.getTile(tgx, tgy);
      const rt = chunk.roadType[index] as RoadType;
      // Heavy trucks keep to the inner (kerb-side) lane, matching the lane
      // geometry the traffic layer uses for every other vehicle.
      if (rt === RoadType.None || rt === RoadType.Rail) {
        truck.laneOffset = 0;
      } else {
        const lanes = Math.max(1, getRoadProperties(rt).lanesPerDirection);
        const centred = (lanes - 1) / 2;
        truck.laneOffset = lanes <= 1 ? 0.1 : 0.1 + centred * 0.055;
      }
    }
    return (truck.routeIdx ?? 0) >= route.length;
  }

  // ---- Crew behaviour -------------------------------------------------------

  private deployCrew(truck: LoggingTruckAgent, chunks: ChunkManager): void {
    for (const c of truck.crew ?? []) {
      c.phase = 'walking_to_tree';
      // Spread the crew out around the truck so they don't stack on one tile.
      const angle = (c.id % FORESTRY_CREW_SIZE) * 0.9;
      c.gx = truck.gx + Math.cos(angle) * 0.4;
      c.gy = truck.gy + Math.sin(angle) * 0.4;
      c.targetGx = c.gx;
      c.targetGy = c.gy;
      c.reservedTreeGx = -1;
      c.reservedTreeGy = -1;
      c.carryingLogs = 0;
      c.treesFelled = 0;
    }
    void chunks;
  }

  /** Reserves the closest unclaimed mature tree for a crew member. */
  private reserveNextTree(
    truck: LoggingTruckAgent,
    crew: ForestryCrewMember,
    chunks: ChunkManager
  ): boolean {
    const r = FORESTRY_WORK_RADIUS;
    let best: { gx: number; gy: number; dist: number } | null = null;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const gx = Math.round(truck.gx) + dx;
        const gy = Math.round(truck.gy) + dy;
        const key = `${gx}:${gy}`;
        if (this.reservedTrees.has(key)) continue;
        if (chunks.isUnlocked(gx, gy)) continue; // locked land only for wild harvest
        const { chunk, index } = chunks.getTile(gx, gy);
        const ft = chunk.featureType[index] as FeatureType;
        if (!isTreeFeature(ft)) continue;
        const stage = (chunk.featureStage?.[index] ?? TreeStage.Mature) as TreeStage;
        if (stage !== TreeStage.Mature) continue;
        const dist = Math.hypot(dx, dy);
        if (!best || dist < best.dist) best = { gx, gy, dist };
      }
    }
    if (!best) return false;
    const key = `${best.gx}:${best.gy}`;
    this.reservedTrees.add(key);
    // The truck keeps its own anchor reservation for the whole trip so the block
    // stays reserved for this vehicle while its crew works through the trees.
    if (truck.reservedTreeGx === undefined) {
      truck.reservedTreeGx = best.gx;
      truck.reservedTreeGy = best.gy;
    }
    crew.reservedTreeGx = best.gx;
    crew.reservedTreeGy = best.gy;
    crew.targetGx = best.gx;
    crew.targetGy = best.gy;
    crew.phase = 'walking_to_tree';
    return true;
  }

  private stepCrew(
    truck: LoggingTruckAgent,
    factory: BuildingInstance,
    dtSec: number,
    state: WorldEngineState,
    chunks: ChunkManager,
    forestry: ForestrySystem,
    onEvent?: (ev: ForestryDeliveryEvent) => void
  ): void {
    const cargoCapacity = truck.cargoCapacity ?? 24;
    const target = truck.tripTargetTrees ?? FORESTRY_MIN_TREES_PER_TRIP;
    const crew = truck.crew ?? [];
    const woodPerTree = 8;

    // Are we done? Either cargo is full, or the trip target is met and no crew
    // member is still carrying logs.
    const anyoneCarrying = crew.some((c) => c.carryingLogs > 0 || c.phase !== 'in_truck');
    if (
      truck.cargoTimber >= cargoCapacity ||
      ((truck.treesFelledThisTrip ?? 0) >= target && !anyoneCarrying && truck.cargoTimber > 0)
    ) {
      this.recallCrew(truck);
      truck.state = 'stockpiling';
      truck.harvestTimer = 0.4;
      truck.statusReason = `Loading complete: ${truck.cargoTimber} timber aboard`;
      return;
    }

    // If nothing is left to harvest at all, go home with whatever we have.
    if (crew.every((c) => c.phase === 'in_truck') && truck.cargoTimber >= cargoCapacity * 0.999) {
      this.recallCrew(truck);
      truck.state = 'stockpiling';
      truck.harvestTimer = 0.3;
      return;
    }

    let anyWork = false;
    for (const c of crew) {
      const walkSpeed = 1.9;
      if (c.phase === 'walking_to_tree') {
        if (c.reservedTreeGx < 0) {
          if (!this.reserveNextTree(truck, c, chunks)) {
            c.phase = 'in_truck';
            continue;
          }
        }
        const tx = c.reservedTreeGx;
        const ty = c.reservedTreeGy;
        const dx = tx - c.gx;
        const dy = ty - c.gy;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.18) {
          const step = Math.min(dist, walkSpeed * dtSec);
          c.gx += (dx / dist) * step;
          c.gy += (dy / dist) * step;
          c.facing = dx - dy >= 0 ? 1 : -1;
          anyWork = true;
          continue;
        }
        c.gx = tx;
        c.gy = ty;
        c.phase = 'chopping';
        c.chopTimer = 0.9;
        anyWork = true;
        continue;
      }

      if (c.phase === 'chopping') {
        c.chopTimer -= dtSec;
        anyWork = true;
        // Load cap check: don't fell a tree we cannot carry.
        if (truck.cargoTimber + c.carryingLogs + woodPerTree > cargoCapacity) {
          c.chopTimer = 0.5;
          continue;
        }
        if (c.chopTimer > 0) continue;

        const tx = c.reservedTreeGx;
        const ty = c.reservedTreeGy;
        const { cx, cy, index } = gridToChunk(tx, ty);
        const chunk = chunks.getOrCreateChunk(cx, cy);
        const ft = chunk.featureType[index] as FeatureType;
        const stage = (chunk.featureStage?.[index] ?? TreeStage.Mature) as TreeStage;
        if (isTreeFeature(ft) && stage === TreeStage.Mature && !chunks.isUnlocked(tx, ty)) {
          const species = TREE_SPECIES[ft];
          chunk.featureType[index] = FeatureType.None;
          chunk.featureHp[index] = 0;
          chunk.featureStage[index] = TreeStage.Empty;
          chunks.markChunkModified(cx, cy);
          // Harvested locked tiles regrow later through the normal lifecycle.
          forestry.scheduleTreeRegrowth(tx, ty, ft, state, { harvested: true });

          const logs = Math.max(2, species?.woodYield ?? woodPerTree);
          c.carryingLogs = logs;
          c.treesFelled += 1;
          truck.treesFelledThisTrip = (truck.treesFelledThisTrip ?? 0) + 1;
          state.stats.treesCut += 1;
          this.harvestedToday += 1;
          state.loggingStats ??= {
            harvestedTrees: 0,
            factoryTimberStock: 0,
            dailyTimberProduction: 0,
            activeTrucks: 0,
            permittedForestTiles: 0,
          };
          state.loggingStats.harvestedTrees += 1;
          const zone = state.forestryWorkZones?.find((z) => z.id === truck.workZoneId);
          if (zone) {
            zone.lastHarvestTick = state.tick;
            zone.harvestedTotal += 1;
            zone.matureTrees = Math.max(0, zone.matureTrees - 1);
            if (zone.matureTrees === 0) zone.cooldownUntilTick = state.tick + 180;
          }
          if (truck.id % 2 === 0 && onEvent) {
            onEvent({ gx: tx, gy: ty, label: '+Logs', color: '#a3e635' });
          }
        }
        this.reservedTrees.delete(`${tx}:${ty}`);
        c.reservedTreeGx = -1;
        c.reservedTreeGy = -1;
        c.phase = c.carryingLogs > 0 ? 'carrying' : 'in_truck';
        continue;
      }

      if (c.phase === 'carrying') {
        const dx = truck.gx - c.gx;
        const dy = truck.gy - c.gy;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.22) {
          const step = Math.min(dist, walkSpeed * 0.85 * dtSec);
          c.gx += (dx / dist) * step;
          c.gy += (dy / dist) * step;
          c.facing = dx - dy >= 0 ? 1 : -1;
          anyWork = true;
          continue;
        }
        // Load into the truck (authoritative cargo accounting).
        const room = Math.max(0, cargoCapacity - truck.cargoTimber);
        const loaded = Math.min(room, c.carryingLogs);
        truck.cargoTimber += loaded;
        c.carryingLogs = 0;
        c.phase = 'in_truck';
        c.gx = truck.gx;
        c.gy = truck.gy;
        anyWork = true;
        continue;
      }

      // in_truck: assign the next tree if capacity and target allow more work.
      if (
        tankHasSpace(truck.cargoTimber, cargoCapacity, woodPerTree) &&
        (truck.treesFelledThisTrip ?? 0) < target
      ) {
        if (this.reserveNextTree(truck, c, chunks)) {
          anyWork = true;
          continue;
        }
      }
    }

    if (!anyWork) {
      // Nothing left at this location. Bank the timber and move on.
      this.recallCrew(truck);
      if (truck.cargoTimber > 0) {
        truck.state = 'stockpiling';
        truck.harvestTimer = 0.4;
        truck.statusReason = `Location exhausted: returning with ${truck.cargoTimber} timber`;
      } else {
        // Empty-handed: mark the zone as unproductive and pick a new one.
        if (truck.workZoneId) {
          this.claimedZones.delete(truck.workZoneId);
          const zone = state.forestryWorkZones?.find((z) => z.id === truck.workZoneId);
          if (zone) {
            zone.matureTrees = 0;
            zone.cooldownUntilTick = state.tick + 180;
          }
          truck.workZoneId = undefined;
        }
        truck.state = 'blocked';
        truck.harvestTimer = 2.5;
        truck.statusReason = 'No mature trees available at this location';
        truck.failureCode = 'forestry_no_mature_trees';
      }
      return;
    }
    truck.statusReason = `Crew harvesting: ${truck.cargoTimber}/${cargoCapacity} timber, ${
      truck.treesFelledThisTrip ?? 0
    }/${target} trees`;
  }

  private recallCrew(truck: LoggingTruckAgent): void {
    for (const c of truck.crew ?? []) {
      if (c.reservedTreeGx >= 0) this.reservedTrees.delete(`${c.reservedTreeGx}:${c.reservedTreeGy}`);
      c.reservedTreeGx = -1;
      c.reservedTreeGy = -1;
      // Teleport the crew back into the cab (they are inside the truck visually).
      c.phase = 'in_truck';
      c.carryingLogs = 0;
      c.gx = truck.gx;
      c.gy = truck.gy;
    }
  }

  private unloadAtFactory(
    truck: LoggingTruckAgent,
    factory: BuildingInstance,
    state: WorldEngineState,
    onEvent: ((ev: ForestryDeliveryEvent) => void) | undefined,
    homeGx: number,
    homeGy: number
  ): void {
    if (truck.cargoTimber > 0) {
      const added = ResourceSystem.addClamped(state, 'wood', truck.cargoTimber);
      factory.realizedOutputTotal = (factory.realizedOutputTotal ?? 0) + added;
      this.harvestedToday += added;
      if (added > 0) {
        onEvent?.({ gx: homeGx, gy: homeGy, label: `+${added} Timber`, color: '#a3e635' });
      }
    }
    truck.cargoTimber = 0;
    truck.treesFelledThisTrip = 0;
    if (truck.workZoneId) this.claimedZones.delete(truck.workZoneId);
    truck.workZoneId = undefined;
    truck.state = 'idle_at_factory';
    truck.onRoad = false;
    truck.route = undefined;
    truck.harvestTimer = 0.6;
    truck.statusReason = 'Unloaded timber at factory';
    state.loggingStats ??= {
      harvestedTrees: 0,
      factoryTimberStock: 0,
      dailyTimberProduction: 0,
      activeTrucks: 0,
      permittedForestTiles: 0,
    };
    state.loggingStats.factoryTimberStock = Math.round(state.resources.wood ?? 0);
    state.loggingStats.dailyTimberProduction = this.harvestedToday;
  }

  /** Utilities: aggregated diagnostics for the diagnostics tool. */
  public describeTrucks(): Array<{
    id: number;
    kind: string;
    state: string;
    gx: number;
    gy: number;
    routeLength: number;
    routeIdx: number;
    cargo: number;
    capacity: number;
    trees: number;
    reason?: string;
    failureCode?: string;
    workZoneId?: string;
  }> {
    return this.trucks.map((t) => ({
      id: t.id,
      kind: 'forestry_truck',
      state: t.state,
      gx: t.gx,
      gy: t.gy,
      routeLength: t.route?.length ?? 0,
      routeIdx: t.routeIdx ?? 0,
      cargo: t.cargoTimber,
      capacity: t.cargoCapacity ?? 0,
      trees: t.treesFelledThisTrip ?? 0,
      reason: t.statusReason,
      failureCode: t.failureCode,
      workZoneId: t.workZoneId,
    }));
  }
}

function tankHasSpace(cargo: number, capacity: number, nextLogs: number): boolean {
  return cargo + nextLogs <= capacity;
}

/** Re-exported so older imports keep working. */
export type { ResourceId };
