import { BUILDINGS, getBuildingFootprint, getBuildingLevelMultiplier } from '../data/buildings.data';
import type { ResourceId } from '../data/resources.data';
import { getRoadProperties, isRoadAllowedForVehicle, ROADS, RoadType } from '../data/roads.data';
import { FeatureType, isTreeFeature, TREE_SPECIES } from '../data/trees.data';
import type { ChunkManager } from '../core/ChunkManager';
import {
  BuildingInstance,
  LoggingTruckAgent,
  RoadVehicleAgent,
  RoadVehicleKind,
  TileFlag,
  TrainAgent,
  VehicleClass,
  WorldEngineState,
} from '../core/GameState';
import { CHUNK_SIZE, chunkToGrid, gridToChunk } from '../core/IsoMath';
import { ForestryFleetSystem } from './ForestryFleetSystem';
import type { ForestrySystem } from './ForestrySystem';
import { PathfindingSystem } from './PathfindingSystem';
import { ResourceSystem } from './ResourceSystem';
import type { RoadNetworkSystem } from './RoadNetworkSystem';

export interface TransportDeliveryEvent {
  gx: number;
  gy: number;
  label: string;
  color: string;
}

const SAWMILL_IDS = new Set([
  'lumber_mill',
  'heavy_lumber_complex',
  'sawmill_mega',
  'plywood_factory',
  'timber_yard',
]);

const CARGO_FALLBACK_RESOURCES: ResourceId[] = ['wood', 'stone', 'wheat', 'bricks', 'iron_ingots', 'tools'];

function getVehicleClass(kind: RoadVehicleKind): VehicleClass {
  switch (kind) {
    case 'car':
    case 'taxi':
      return 'car';
    case 'delivery_van':
    case 'fish_van':
      return 'van';
    case 'bus':
      return 'bus';
    case 'emergency':
      return 'emergency';
    default:
      return 'heavy_truck';
  }
}

function getBaseMaxSpeed(kind: RoadVehicleKind): number {
  switch (kind) {
    case 'emergency':
      return 3.4;
    case 'car':
      return 2.95;
    case 'taxi':
      return 2.85;
    case 'delivery_van':
    case 'fish_van':
      return 2.55;
    case 'bus':
      return 2.25;
    case 'cargo_truck':
    case 'construction_truck':
      return 2.05;
    case 'container_truck':
      return 1.9;
    case 'tractor':
      return 1.6;
  }
}

function getLaneOffsetForTile(
  gx: number,
  gy: number,
  vehicleId: number,
  chunks: ChunkManager
): number {
  const { chunk, index } = chunks.getTile(gx, gy);
  const rt = chunk.roadType[index] as RoadType;
  if (rt === RoadType.None || rt === RoadType.Rail) return 0;
  const props = getRoadProperties(rt);
  if (props.totalLanes <= 1) return 0;
  const baseOffset =
    props.widthClass === 'highway'
      ? 0.24
      : props.widthClass === 'wide'
        ? 0.2
        : 0.16;
  const multiLaneShift = props.lanesPerDirection >= 2 ? ((vehicleId % 2 === 0 ? -0.04 : 0.05)) : 0;
  return baseOffset + multiLaneShift;
}

export class LogisticsAndTransportSystem {
  /** Forestry trucks live in their own system; exposed here for read-only UI/traffic. */
  public readonly forestryFleet = new ForestryFleetSystem();
  public get loggingTrucks(): LoggingTruckAgent[] {
    return this.forestryFleet.trucks;
  }
  public readonly trains: TrainAgent[] = [];
  public readonly roadVehicles: RoadVehicleAgent[] = [];

  private nextId = 1;
  private syncAccum = 0;
  private trafficSampleAccum = 0;
  private internalSimClockSec = 0;
  private cachedRailTiles: Array<{ gx: number; gy: number }> = [];
  private cachedRoadTiles: Array<{ gx: number; gy: number }> = [];
  private railSet = new Set<string>();
  private roadSet = new Set<string>();
  private harvestedToday = 0;
  private lastDayReset = -1;

  public reset(): void {
    this.forestryFleet.reset();
    this.trains.length = 0;
    this.roadVehicles.length = 0;
    this.cachedRailTiles = [];
    this.cachedRoadTiles = [];
    this.railSet.clear();
    this.roadSet.clear();
    this.syncAccum = 0;
    this.trafficSampleAccum = 0;
    this.internalSimClockSec = 0;
    this.harvestedToday = 0;
    this.lastDayReset = -1;
    this.cargoClaims.clear();
    this.junctionReservations.clear();
    this.junctionHoldTimers.clear();
    this.edgeOccupation.clear();
  }

  public update(
    dtSec: number,
    state: WorldEngineState,
    chunks: ChunkManager,
    roadNet?: RoadNetworkSystem,
    simTimeSec?: number,
    onEvent?: (ev: TransportDeliveryEvent) => void,
    forestry?: ForestrySystem
  ): void {
    this.internalSimClockSec += dtSec;
    const effectiveTimeSec = simTimeSec ?? this.internalSimClockSec;

    const dayKey = state.year * 100 + state.dayInSeason;
    if (this.lastDayReset !== dayKey) {
      this.lastDayReset = dayKey;
      this.harvestedToday = 0;
    }

    this.syncAccum += dtSec;
    if (
      this.syncAccum >= 2.0 ||
      (this.trains.length === 0 && this.loggingTrucks.length === 0 && this.roadVehicles.length === 0 && this.syncAccum >= 0.4)
    ) {
      this.syncAccum = 0;
      this.rebuildNetworkCache(chunks);
      if (roadNet) {
        roadNet.recomputeIfDirty(chunks, state);
      }
      this.syncForestryFleets(state, chunks, roadNet);
      this.syncTrains(state);
      this.syncRoadVehicles(state, chunks, roadNet);
    }

    if (roadNet && forestry) {
      this.forestryFleet.update(
        dtSec,
        state,
        chunks,
        roadNet,
        forestry,
        onEvent ? (ev) => onEvent({ gx: ev.gx, gy: ev.gy, label: ev.label, color: ev.color }) : undefined
      );
    }
    this.stepTrains(dtSec);
    this.stepRoadVehicles(dtSec, state, chunks, roadNet, effectiveTimeSec, onEvent);

    if (roadNet) {
      this.trafficSampleAccum += dtSec;
      if (this.trafficSampleAccum >= 0.35) {
        this.trafficSampleAccum = 0;
        const tileVehicleCount = new Map<string, number>();
        const tileWaitingCount = new Map<string, number>();

        for (const rv of this.roadVehicles) {
          const key = `${Math.round(rv.gx)}:${Math.round(rv.gy)}`;
          tileVehicleCount.set(key, (tileVehicleCount.get(key) ?? 0) + 1);
          if (rv.state === 'waiting_signal' || rv.state === 'waiting_traffic') {
            tileWaitingCount.set(key, (tileWaitingCount.get(key) ?? 0) + 1);
          }
        }
        for (const lt of this.forestryFleet.trucks) {
          if (!lt.onRoad) continue;
          const key = `${Math.round(lt.gx)}:${Math.round(lt.gy)}`;
          tileVehicleCount.set(key, (tileVehicleCount.get(key) ?? 0) + 1);
        }

        roadNet.recordTrafficSample(tileVehicleCount, tileWaitingCount, chunks, state);
      }
    }
  }

  private rebuildNetworkCache(chunks: ChunkManager): void {
    this.cachedRailTiles = [];
    this.cachedRoadTiles = [];
    this.railSet.clear();
    this.roadSet.clear();

    for (const chunk of chunks.getAllLoadedChunks()) {
      for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++) {
        const rt = chunk.roadType[i] as RoadType;
        if (rt === RoadType.None) continue;
        const { gx, gy } = chunkToGrid(chunk.cx, chunk.cy, i % CHUNK_SIZE, Math.floor(i / CHUNK_SIZE));
        const key = `${gx}:${gy}`;
        if (rt === RoadType.Rail) {
          this.cachedRailTiles.push({ gx, gy });
          this.railSet.add(key);
        } else {
          this.cachedRoadTiles.push({ gx, gy });
          this.roadSet.add(key);
        }
      }
    }
  }

  /**
   * Forestry fleet responsibility moved to ForestryFleetSystem (a dedicated
   * system that owns work-zones, scheduling and the 5-6 man harvesting crew).
   * This system keeps traffic, general freight and trains.
   */
  private syncForestryFleets(state: WorldEngineState, chunks: ChunkManager, roadNet?: RoadNetworkSystem): void {
    if (!roadNet) return;
    this.forestryFleet.surveyWorkZones(state, chunks, roadNet);
    this.forestryFleet.syncFleets(state, chunks, roadNet);
  }

  private syncTrains(state: WorldEngineState): void {
    if (this.cachedRailTiles.length < 3) {
      this.trains.length = 0;
      return;
    }

    const stationCount = state.buildings.filter((b) => {
      const def = BUILDINGS[b.defId];
      return def?.transitKind === 'rail' && b.status !== 'constructing' && b.enabled;
    }).length;
    const hasFreightYard = state.buildings.some(
      (b) => b.defId === 'freight_rail_yard' && b.status !== 'constructing'
    );

    const desiredTrains = Math.min(
      8,
      Math.max(1, Math.min(Math.floor(this.cachedRailTiles.length / 6), 1 + stationCount))
    );

    while (this.trains.length < desiredTrains) {
      const start = this.cachedRailTiles[(this.trains.length * 5) % this.cachedRailTiles.length];
      this.trains.push({
        id: this.nextId++,
        kind: hasFreightYard && this.trains.length % 2 === 1 ? 'freight' : 'passenger',
        gx: start.gx,
        gy: start.gy,
        prevGx: start.gx,
        prevGy: start.gy,
        progress: 1,
        facing: 1,
        cars: 3,
      });
    }
    if (this.trains.length > desiredTrains) {
      this.trains.length = desiredTrains;
    }
  }

  private stepTrains(dtSec: number): void {
    if (this.trains.length === 0 || this.railSet.size === 0) return;

    for (const train of this.trains) {
      const tx = Math.round(train.gx);
      const ty = Math.round(train.gy);
      if (!this.railSet.has(`${tx}:${ty}`)) {
        if (this.cachedRailTiles.length > 0) {
          const fallback = this.cachedRailTiles[train.id % this.cachedRailTiles.length];
          train.gx = fallback.gx;
          train.gy = fallback.gy;
          train.prevGx = fallback.gx;
          train.prevGy = fallback.gy;
          train.progress = 1;
        }
        continue;
      }

      if (train.progress >= 1) {
        const neighbors: Array<[number, number]> = [];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = tx + dx;
          const ny = ty + dy;
          if (this.railSet.has(`${nx}:${ny}`)) {
            neighbors.push([nx, ny]);
          }
        }
        if (neighbors.length === 0) continue;

        const forward = neighbors.filter(([nx, ny]) => nx !== train.prevGx || ny !== train.prevGy);
        const pool = forward.length > 0 ? forward : neighbors;
        const pick = pool[(train.id + tx * 3 + ty * 7) % pool.length];
        train.prevGx = tx;
        train.prevGy = ty;
        train.progress = 0;
        const dx = pick[0] - tx;
        const dy = pick[1] - ty;
        train.facing = dx - dy >= 0 ? 1 : -1;
        train.gx = tx + dx * 0.01;
        train.gy = ty + dy * 0.01;
      } else {
        const dirX = Math.sign(train.gx - train.prevGx);
        const dirY = Math.sign(train.gy - train.prevGy);
        const destX = train.prevGx + dirX;
        const destY = train.prevGy + dirY;
        const speed = train.kind === 'passenger' ? 3.2 : 2.3;
        train.progress = Math.min(1, train.progress + speed * dtSec);
        train.gx = train.prevGx + dirX * train.progress;
        train.gy = train.prevGy + dirY * train.progress;
        if (train.progress >= 1) {
          train.gx = destX;
          train.gy = destY;
        }
      }
    }
  }

  private getRoadAccessibleBuildings(
    state: WorldEngineState,
    chunks: ChunkManager,
    roadNet?: RoadNetworkSystem
  ): BuildingInstance[] {
    const out: BuildingInstance[] = [];
    for (const b of state.buildings) {
      if (!b.enabled) continue;
      if (roadNet) {
        const access = roadNet.getCachedRoadAccess(b, chunks);
        if (access.accessPoints.some((ap) => ap.roadType !== RoadType.Rail)) {
          out.push(b);
        }
      } else if (PathfindingSystem.findBuildingEntrances(b, chunks, 'vehicle').length > 0) {
        out.push(b);
      }
    }
    return out;
  }

  private syncRoadVehicles(
    state: WorldEngineState,
    chunks: ChunkManager,
    roadNet?: RoadNetworkSystem
  ): void {
    if (this.cachedRoadTiles.length < 2) {
      this.roadVehicles.length = 0;
      return;
    }

    const roadBuildings = this.getRoadAccessibleBuildings(state, chunks, roadNet);

    let busWanted = 0;
    let taxiWanted = 0;
    let carWanted = 0;
    let deliveryWanted = 0;
    let fishVanWanted = 0;
    let cargoWanted = 0;
    let containerWanted = 0;
    let tractorWanted = 0;
    let constructionWanted = 0;
    let emergencyWanted = 0;

    for (const b of roadBuildings) {
      const def = BUILDINGS[b.defId];
      if (!def) continue;

      if (b.status === 'constructing') {
        constructionWanted = Math.min(3, constructionWanted + 1);
        continue;
      }

      if (def.transitKind === 'bus') busWanted += 2;
      if (def.transitKind === 'taxi') taxiWanted += 2;
      if (def.category === 'residential') carWanted += 1;
      if (def.category === 'commercial' || def.subCategory === 'market') deliveryWanted += 1;
      if (def.subCategory === 'fishing' || b.defId === 'fish_market') fishVanWanted += 1;
      if (def.subCategory === 'farming' || b.defId === 'farm_equipment_depot') tractorWanted += 1;
      if (
        def.category === 'production' ||
        def.category === 'industrial' ||
        def.category === 'storage' ||
        def.subCategory === 'mega_factory'
      ) {
        cargoWanted += 1;
      }
      if (
        def.subCategory === 'trade_port' ||
        def.exportsSurplus ||
        def.importsUnavailable ||
        def.isCustoms ||
        def.transitKind === 'sea' ||
        def.transitKind === 'air'
      ) {
        containerWanted += 1;
      }
      if (def.category === 'healthcare' || (def.safetyBonus ?? 0) > 0) {
        emergencyWanted += 1;
      }
    }

    // Also allow small starter cars when at least 2 road buildings exist on roads
    if (roadBuildings.length >= 2 && carWanted === 0 && state.population.total > 0) {
      carWanted = 1;
    }

    const desiredKinds: RoadVehicleKind[] = [];
    const pushCapped = (kind: RoadVehicleKind, count: number, cap: number) => {
      const n = Math.min(cap, count);
      for (let i = 0; i < n; i++) desiredKinds.push(kind);
    };

    pushCapped('bus', busWanted, 6);
    pushCapped('taxi', taxiWanted, 5);
    pushCapped('car', Math.floor((carWanted + 1) / 2), 6);
    pushCapped('delivery_van', deliveryWanted, 5);
    pushCapped('fish_van', fishVanWanted, 3);
    pushCapped('cargo_truck', cargoWanted, 6);
    pushCapped('container_truck', containerWanted, 4);
    pushCapped('tractor', tractorWanted, 3);
    pushCapped('construction_truck', constructionWanted, 3);
    pushCapped('emergency', emergencyWanted, 3);

    desiredKinds.length = Math.min(desiredKinds.length, 32);

    if (desiredKinds.length === 0) {
      this.roadVehicles.length = 0;
      return;
    }

    while (this.roadVehicles.length < desiredKinds.length) {
      const idx = this.roadVehicles.length;
      const kind = desiredKinds[idx];
      const start = this.pickSpawnRoadTile(kind, roadBuildings, chunks, idx);
      const vClass = getVehicleClass(kind);
      const veh: RoadVehicleAgent = {
        id: this.nextId++,
        kind,
        vehicleClass: vClass,
        gx: start.gx,
        gy: start.gy,
        prevGx: start.gx,
        prevGy: start.gy,
        nextGx: start.gx,
        nextGy: start.gy,
        progress: 1,
        facing: 1,
        vx: 0,
        vy: 0,
        laneOffset: 0,
        speed: 0,
        maxSpeed: getBaseMaxSpeed(kind),
        state: 'idle',
        waitTimer: 0.2 + (idx % 4) * 0.25,
        blockedSec: 0,
        route: [],
        routeIdx: 0,
        routeVersion: 0,
      };
      this.assignTrip(veh, state, chunks, roadNet, roadBuildings);
      this.roadVehicles.push(veh);
    }

    if (this.roadVehicles.length > desiredKinds.length) {
      // Release freight claims held by the vehicles we are about to remove, so
      // despawned trucks can never permanently reserve stock.
      for (let i = desiredKinds.length; i < this.roadVehicles.length; i++) {
        const gone = this.roadVehicles[i];
        this.releaseCargoClaim(gone.sourceBuildingId, gone.cargoResource, gone.cargoAmount ?? 0);
        const at = `${Math.round(gone.gx)}:${Math.round(gone.gy)}`;
        this.junctionReservations.delete(at);
        this.junctionHoldTimers.delete(at);
      }
      this.roadVehicles.length = desiredKinds.length;
    }

    for (let i = 0; i < this.roadVehicles.length; i++) {
      const veh = this.roadVehicles[i];
      if (veh.kind !== desiredKinds[i]) {
        // Retasking a vehicle releases whatever it had promised to haul.
        this.releaseCargoClaim(veh.sourceBuildingId, veh.cargoResource, veh.cargoAmount ?? 0);
        veh.cargoAmount = 0;
        veh.cargoResource = undefined;
        veh.kind = desiredKinds[i];
        veh.vehicleClass = getVehicleClass(desiredKinds[i]);
        veh.maxSpeed = getBaseMaxSpeed(desiredKinds[i]);
      }
      if (veh.route.length === 0 && veh.state === 'idle' && veh.waitTimer <= 0) {
        this.assignTrip(veh, state, chunks, roadNet, roadBuildings);
      }
    }
  }

  private pickSpawnRoadTile(
    kind: RoadVehicleKind,
    roadBuildings: BuildingInstance[],
    chunks: ChunkManager,
    seedIdx: number
  ): { gx: number; gy: number } {
    if (roadBuildings.length > 0) {
      const b = roadBuildings[seedIdx % roadBuildings.length];
      const entrances = PathfindingSystem.findBuildingEntrances(b, chunks, 'vehicle');
      if (entrances.length > 0) return entrances[0];
    }
    void kind;
    return this.cachedRoadTiles[(seedIdx * 7) % this.cachedRoadTiles.length];
  }

  private pickSourceAndDest(
    kind: RoadVehicleKind,
    state: WorldEngineState,
    roadBuildings: BuildingInstance[],
    roadNet?: RoadNetworkSystem,
    seed = 1
  ): {
    source?: BuildingInstance;
    dest?: BuildingInstance;
    cargoResource?: ResourceId;
    cargoAmount?: number;
  } {
    if (roadBuildings.length === 0) return {};

    const constructing = roadBuildings.filter((b) => b.status === 'constructing');
    const active = roadBuildings.filter((b) => b.status !== 'constructing');
    const byMatch = (pred: (b: BuildingInstance) => boolean) => active.filter(pred);

    let sources: BuildingInstance[] = [];
    let dests: BuildingInstance[] = [];
    let cargoResource: ResourceId | undefined;
    let cargoAmount = 0;

    switch (kind) {
      case 'construction_truck': {
        sources = byMatch((b) => {
          const def = BUILDINGS[b.defId];
          return Boolean(
            def &&
              (def.category === 'storage' ||
                def.category === 'industrial' ||
                def.category === 'government' ||
                b.defId === 'sawmill_mega')
          );
        });
        if (sources.length === 0) sources = active;
        dests = constructing;
        cargoResource = 'bricks';
        cargoAmount = 2;
        break;
      }
      case 'container_truck': {
        sources = byMatch((b) => {
          const def = BUILDINGS[b.defId];
          return Boolean(
            def &&
              (def.subCategory === 'trade_port' ||
                def.exportsSurplus ||
                def.importsUnavailable ||
                def.isCustoms ||
                def.transitKind === 'sea' ||
                def.transitKind === 'air')
          );
        });
        dests = byMatch((b) => {
          const def = BUILDINGS[b.defId];
          return Boolean(
            def && (def.category === 'storage' || def.category === 'industrial' || def.category === 'production')
          );
        });
        cargoResource = 'tools';
        cargoAmount = 3;
        break;
      }
      case 'cargo_truck': {
        sources = byMatch((b) => {
          const def = BUILDINGS[b.defId];
          return Boolean(
            def && (def.category === 'production' || def.category === 'industrial' || def.subCategory === 'mega_factory')
          );
        });
        dests = byMatch((b) => {
          const def = BUILDINGS[b.defId];
          return Boolean(def && (def.category === 'storage' || def.category === 'commercial' || def.subCategory === 'market'));
        });
        break;
      }
      case 'delivery_van': {
        sources = byMatch((b) => {
          const def = BUILDINGS[b.defId];
          return Boolean(def && (def.category === 'agricultural' || def.category === 'storage' || def.category === 'production'));
        });
        dests = byMatch((b) => {
          const def = BUILDINGS[b.defId];
          return Boolean(def && (def.category === 'commercial' || def.subCategory === 'market' || def.category === 'residential'));
        });
        cargoResource = 'bread';
        cargoAmount = 2;
        break;
      }
      case 'fish_van': {
        sources = byMatch((b) => BUILDINGS[b.defId]?.subCategory === 'fishing');
        dests = byMatch((b) => {
          const def = BUILDINGS[b.defId];
          return Boolean(def && (b.defId === 'fish_market' || def.category === 'commercial' || def.subCategory === 'market'));
        });
        cargoResource = 'fish';
        cargoAmount = 2;
        break;
      }
      case 'tractor': {
        sources = byMatch((b) => b.defId === 'farm_equipment_depot' || BUILDINGS[b.defId]?.subCategory === 'farming');
        dests = byMatch((b) => BUILDINGS[b.defId]?.subCategory === 'farming' || BUILDINGS[b.defId]?.category === 'agricultural');
        cargoResource = 'wheat';
        cargoAmount = 2;
        break;
      }
      case 'emergency': {
        sources = byMatch((b) => {
          const def = BUILDINGS[b.defId];
          return Boolean(def && (def.category === 'healthcare' || (def.safetyBonus ?? 0) > 0));
        });
        dests = byMatch((b) => BUILDINGS[b.defId]?.category === 'residential' || BUILDINGS[b.defId]?.category === 'industrial');
        break;
      }
      case 'bus':
      case 'taxi': {
        sources = byMatch((b) => BUILDINGS[b.defId]?.transitKind === kind || BUILDINGS[b.defId]?.category === 'residential');
        dests = byMatch((b) => {
          const def = BUILDINGS[b.defId];
          return Boolean(def && (def.category === 'commercial' || def.category === 'government' || def.category === 'educational' || def.category === 'recreational'));
        });
        break;
      }
      default: {
        sources = byMatch((b) => BUILDINGS[b.defId]?.category === 'residential');
        dests = byMatch((b) => {
          const def = BUILDINGS[b.defId];
          return Boolean(def && (def.category === 'commercial' || def.category === 'government' || def.category === 'industrial' || def.subCategory === 'corporate'));
        });
        break;
      }
    }

    if (sources.length === 0) sources = active.length > 0 ? active : roadBuildings;
    if (dests.length === 0) dests = active.length > 0 ? active : roadBuildings;

    // Prefer a source that actually holds unclaimed stock of the resource this
    // kind of vehicle carries. Falling back to a random source is what produced
    // "truck wanders with nothing in it" behaviour.
    if (cargoResource) {
      const stocked = sources.filter(
        (b) => this.getUnclaimedAmount(b.id, cargoResource as ResourceId, state) > 0
      );
      if (stocked.length > 0) {
        sources = stocked;
      } else {
        // No stock anywhere: stop here rather than dispatch an empty run.
        return {};
      }
    }

    const source = sources[seed % sources.length];
    const sourceCluster = source.connectedRoadCluster;

    // Strictly restrict destination to the SAME connected road cluster so vehicles never cross disconnected networks
    const sameClusterDests = dests.filter(
      (d) =>
        d.id !== source.id &&
        (sourceCluster === 0 || d.connectedRoadCluster === sourceCluster)
    );
    const dest =
      sameClusterDests.length > 0
        ? sameClusterDests[(seed * 3 + 1) % sameClusterDests.length]
        : undefined;

    if (!cargoResource && source) {
      const sDef = BUILDINGS[source.defId];
      const outKeys = sDef?.recipe ? (Object.keys(sDef.recipe.outputs) as ResourceId[]) : [];
      // Pick the first output this source still has stock of.
      const stockedOut = outKeys.find(
        (k) => this.getUnclaimedAmount(source.id, k, state) > 0
      );
      if (stockedOut) {
        cargoResource = stockedOut;
        cargoAmount = 2;
      } else if (kind === 'cargo_truck') {
        const fallback = CARGO_FALLBACK_RESOURCES.find(
          (k) => this.getUnclaimedAmount(source.id, k, state) > 0
        );
        if (fallback) {
          cargoResource = fallback;
          cargoAmount = 1;
        }
      }
    }

    void roadNet;
    return { source, dest, cargoResource, cargoAmount };
  }

  private claimCargo(sourceId: number, resource: ResourceId, amount: number): void {
    const key = `${sourceId}:${resource}`;
    this.cargoClaims.set(key, (this.cargoClaims.get(key) ?? 0) + amount);
  }

  private releaseCargoClaim(sourceId: number | undefined, resource: ResourceId | undefined, amount: number): void {
    if (sourceId === undefined || !resource) return;
    const key = `${sourceId}:${resource}`;
    const left = Math.max(0, (this.cargoClaims.get(key) ?? 0) - amount);
    if (left <= 0) this.cargoClaims.delete(key);
    else this.cargoClaims.set(key, left);
  }

  /** How much of a resource is still unclaimed across all in-flight vehicles. */
  private getUnclaimedAmount(buildingId: number, resource: ResourceId, state: WorldEngineState): number {
    const have = Math.floor(state.resources[resource] ?? 0);
    return Math.max(0, have - (this.cargoClaims.get(`${buildingId}:${resource}`) ?? 0));
  }

  private assignTrip(
    veh: RoadVehicleAgent,
    state: WorldEngineState,
    chunks: ChunkManager,
    roadNet?: RoadNetworkSystem,
    cachedBuildings?: BuildingInstance[]
  ): boolean {
    const roadBuildings = cachedBuildings ?? this.getRoadAccessibleBuildings(state, chunks, roadNet);
    const curGx = Math.round(veh.gx);
    const curGy = Math.round(veh.gy);
    const onRoadNow = this.roadSet.has(`${curGx}:${curGy}`);

    const { source, dest, cargoResource, cargoAmount } = this.pickSourceAndDest(
      veh.kind,
      state,
      roadBuildings,
      roadNet,
      veh.id + state.tick
    );

    // Release the previous trip's claim before considering a new one.
    this.releaseCargoClaim(veh.sourceBuildingId, veh.cargoResource, veh.cargoAmount ?? 0);

    const FREIGHT_KINDS: RoadVehicleKind[] = [
      'cargo_truck',
      'delivery_van',
      'fish_van',
      'tractor',
      'construction_truck',
    ];
    const isFreight = FREIGHT_KINDS.includes(veh.kind);

    veh.sourceBuildingId = source?.id;
    veh.destBuildingId = dest?.id;
    if (veh.returning) {
      veh.cargoResource = undefined;
      veh.cargoAmount = 0;
    } else if (isFreight) {
      // Never depart empty: freight vehicles only leave with goods that exist and
      // are not already promised to another vehicle.
      const deliverable =
        source && cargoResource ? this.getUnclaimedAmount(source.id, cargoResource, state) : 0;
      const loadable = Math.min(cargoAmount ?? 0, deliverable);
      if (!source || !dest || !cargoResource || loadable <= 0) {
        veh.cargoResource = undefined;
        veh.cargoAmount = 0;
        veh.route = [];
        veh.routeIdx = 0;
        veh.state = 'idle';
        veh.speed = 0;
        veh.waitTimer = 2.5;
        veh.statusReason = !source
          ? 'Parked: no building with road access produces freight'
          : !dest
            ? 'Parked: no reachable customer on this road network'
            : `Parked: no unclaimed ${cargoResource} at source`;
        veh.parked = true;
        return false;
      }
      veh.cargoResource = cargoResource;
      veh.cargoAmount = loadable;
      this.claimCargo(source.id, cargoResource, loadable);
    } else {
      veh.cargoResource = cargoResource;
      veh.cargoAmount = cargoAmount;
    }

    const congestionMap = roadNet?.getTileCongestionMap();
    const pathOpts = { vehicleClass: veh.vehicleClass, congestionMap };

    // Determine target building (either destination or return to source)
    const targetB = veh.returning ? source : dest ?? source;
    if (targetB) {
      const targetEntrances = PathfindingSystem.findBuildingEntrances(targetB, chunks, 'vehicle');
      let startTile = onRoadNow ? { gx: curGx, gy: curGy } : null;
      if (!startTile && source && veh.state === 'idle') {
        const srcEntrances = PathfindingSystem.findBuildingEntrances(source, chunks, 'vehicle');
        if (srcEntrances.length > 0) {
          startTile = srcEntrances[0];
          veh.gx = startTile.gx;
          veh.gy = startTile.gy;
          veh.prevGx = startTile.gx;
          veh.prevGy = startTile.gy;
        }
      }

      if (startTile && targetEntrances.length > 0) {
        for (const endTile of targetEntrances.slice(0, 4)) {
          if (endTile.gx === startTile.gx && endTile.gy === startTile.gy) continue;
          const path = PathfindingSystem.findPath(
            startTile.gx,
            startTile.gy,
            endTile.gx,
            endTile.gy,
            chunks,
            'vehicle',
            420,
            pathOpts
          );
          if (path && path.length > 0) {
            veh.route = path;
            veh.routeIdx = 0;
            veh.routeVersion = roadNet?.networkVersion ?? 1;
            veh.prevGx = startTile.gx;
            veh.prevGy = startTile.gy;
            veh.nextGx = path[0].gx;
            veh.nextGy = path[0].gy;
            veh.progress = 0;
            veh.state = 'en_route';
            veh.blockedSec = 0;
            veh.parked = false;
            veh.statusReason = veh.returning ? 'Returning empty on road' : 'Delivering freight on road';
            return true;
          }
        }
      }
    }

    // Local connected road cruise fallback within the same road network cluster
    if (onRoadNow) {
      const clusterId = roadNet?.getRoadClusterId(curGx, curGy) ?? 0;
      const sameClusterTiles =
        clusterId > 0 && roadNet
          ? this.cachedRoadTiles.filter((t) => roadNet.getRoadClusterId(t.gx, t.gy) === clusterId)
          : this.cachedRoadTiles;

      for (let attempt = 0; attempt < 5 && sameClusterTiles.length > 1; attempt++) {
        const pick = sameClusterTiles[(veh.id * 17 + state.tick * 7 + attempt * 13) % sameClusterTiles.length];
        if (pick.gx === curGx && pick.gy === curGy) continue;
        const path = PathfindingSystem.findPath(curGx, curGy, pick.gx, pick.gy, chunks, 'vehicle', 280, pathOpts);
        if (path && path.length > 0) {
          veh.route = path;
          veh.routeIdx = 0;
          veh.routeVersion = roadNet?.networkVersion ?? 1;
          veh.prevGx = curGx;
          veh.prevGy = curGy;
          veh.nextGx = path[0].gx;
          veh.nextGy = path[0].gy;
          veh.progress = 0;
          veh.state = 'en_route';
          veh.blockedSec = 0;
          veh.statusReason = 'Patrolling connected road network';
          return true;
        }
      }
    }

    veh.route = [];
    veh.routeIdx = 0;
    veh.state = 'idle';
    veh.speed = 0;
    veh.waitTimer = 3.0;
    // No route at all: park instead of idling on the carriageway. The diagnostics
    // panel reports this as `vehicle_unreachable` with the exact reason.
    veh.parked = onRoadNow;
    veh.statusReason = 'Blocked: No connected road route';
    return false;
  }

  private rerouteOrRecover(
    veh: RoadVehicleAgent,
    state: WorldEngineState,
    chunks: ChunkManager,
    roadNet?: RoadNetworkSystem
  ): void {
    const tx = Math.round(veh.gx);
    const ty = Math.round(veh.gy);
    let onRoadNow = this.roadSet.has(`${tx}:${ty}`);
    if (!onRoadNow) {
      // Only allow 1-tile orthogonal adjustment onto an adjacent road; never teleport across terrain
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (this.roadSet.has(`${nx}:${ny}`)) {
          veh.gx = nx;
          veh.gy = ny;
          veh.prevGx = nx;
          veh.prevGy = ny;
          veh.nextGx = nx;
          veh.nextGy = ny;
          veh.progress = 1;
          onRoadNow = true;
          break;
        }
      }
    }

    if (!onRoadNow) {
      veh.route = [];
      veh.routeIdx = 0;
      veh.state = 'idle';
      veh.speed = 0;
      veh.waitTimer = 2.0;
      veh.parked = false;
      veh.statusReason = 'Halted: Road removed underneath vehicle';
      return;
    }

    if (veh.route.length > 0) {
      const goal = veh.route[veh.route.length - 1];
      const curX = Math.round(veh.gx);
      const curY = Math.round(veh.gy);
      if (this.roadSet.has(`${goal.gx}:${goal.gy}`)) {
        const newPath = PathfindingSystem.findPath(curX, curY, goal.gx, goal.gy, chunks, 'vehicle', 380, {
          vehicleClass: veh.vehicleClass,
          congestionMap: roadNet?.getTileCongestionMap(),
        });
        if (newPath && newPath.length > 0) {
          veh.route = newPath;
          veh.routeIdx = 0;
          veh.routeVersion = roadNet?.networkVersion ?? 1;
          veh.prevGx = curX;
          veh.prevGy = curY;
          veh.nextGx = newPath[0].gx;
          veh.nextGy = newPath[0].gy;
          veh.progress = 0;
          veh.state = 'en_route';
          veh.blockedSec = 0;
          veh.statusReason = 'Rerouted on road network';
          return;
        }
      }
    }

    this.assignTrip(veh, state, chunks, roadNet);
  }

  private applyDeliveryCompletion(
    veh: RoadVehicleAgent,
    state: WorldEngineState,
    onEvent?: (ev: TransportDeliveryEvent) => void
  ): void {
    // Whatever happens next, this vehicle no longer holds the goods it carried.
    this.releaseCargoClaim(veh.sourceBuildingId, veh.cargoResource, veh.cargoAmount ?? 0);
    veh.cargoAmount = 0;
    veh.cargoResource = undefined;
    if (veh.returning) return;
    const dest = veh.destBuildingId ? state.buildings.find((b) => b.id === veh.destBuildingId) : undefined;
    if (!dest) return;

    if (veh.kind === 'construction_truck' && dest.status === 'constructing') {
      dest.buildProgress = Math.min(0.99, dest.buildProgress + 0.04);
      if (veh.id % 2 === 0) {
        onEvent?.({ gx: dest.gx, gy: dest.gy, label: '+4% Build Supply', color: '#fbbf24' });
      }
      return;
    }

    if (
      veh.cargoResource &&
      veh.cargoAmount &&
      veh.cargoAmount > 0 &&
      (veh.kind === 'cargo_truck' ||
        veh.kind === 'container_truck' ||
        veh.kind === 'delivery_van' ||
        veh.kind === 'fish_van' ||
        veh.kind === 'tractor')
    ) {
      const added = ResourceSystem.addClamped(state, veh.cargoResource, veh.cargoAmount);
      if (added > 0 && veh.id % 5 === 0) {
        onEvent?.({ gx: dest.gx, gy: dest.gy, label: `+${added} Freight`, color: '#38bdf8' });
      }
      const def = BUILDINGS[dest.defId];
      if (def?.exportsSurplus || def?.category === 'commercial') {
        state.coins += 1;
        state.stats.totalCoinsEarned += 1;
      }
    }
  }
  // ===========================================================================
  // Layer 2: traffic simulation
  // ===========================================================================

  /** Intersection reservation table: tile -> vehicle id currently crossing it. */
  private junctionReservations = new Map<string, number>();
  /** Vehicles currently traversing each directed edge (prev -> next). */
  private edgeOccupation = new Map<string, RoadVehicleAgent[]>();
  /**
   * Freight already promised to a vehicle that has not delivered yet, keyed by
   * `buildingId:resource`. This is what prevents two trucks from hauling the
   * same goods out of the same factory in the same trip window.
   */
  private cargoClaims = new Map<string, number>();
  private junctionHoldTimers = new Map<string, number>();

  /**
   * Lane index for a vehicle travelling in direction (dx, dy) on a given road.
   *
   * Roads are modelled as `lanesPerDirection` lanes per direction. Right-hand
   * traffic: the lane offset grows with how many lanes exist, and vehicles moving
   * in opposite directions are mirrored so they never overlap on the centreline.
   */
  private static getLaneIndex(
    gx: number,
    gy: number,
    dx: number,
    dy: number,
    vehicleId: number,
    chunks: ChunkManager
  ): number {
    const { chunk, index } = chunks.getTile(gx, gy);
    const rt = chunk.roadType[index] as RoadType;
    if (rt === RoadType.None || rt === RoadType.Rail) return 0;
    const props = getRoadProperties(rt);
    const lanes = Math.max(1, props.lanesPerDirection);
    if (lanes <= 1) return 0;
    // Larger vehicles hug the inner lane; small ones use the outer lane.
    const heavy = props.widthClass === 'highway' ? 1 : 0;
    return Math.min(lanes - 1, heavy + (vehicleId % 2 === 0 ? 0 : Math.min(lanes - 1, 1)));
  }

  private static laneOffsetFor(vehicleId: number, lanes: number, laneIndex: number, widthClass: string): number {
    if (lanes <= 1) return 0;
    const perLane = widthClass === 'highway' ? 0.075 : widthClass === 'wide' ? 0.07 : 0.055;
    const centred = laneIndex - (lanes - 1) / 2;
    // Right-hand traffic: keep the offset on the correct side of the centreline.
    const side = vehicleId % 2 === 0 ? 1 : -1;
    return side * (0.1 + Math.abs(centred) * perLane);
  }

  /**
   * Main traffic step: lane-following movement, safe headway, signal compliance,
   * intersection reservation (no gridlock into a blocked junction), queue
   * formation and guaranteed deadlock recovery.
   */
  private stepRoadVehicles(
    dtSec: number,
    state: WorldEngineState,
    chunks: ChunkManager,
    roadNet: RoadNetworkSystem | undefined,
    simTimeSec: number,
    onEvent?: (ev: TransportDeliveryEvent) => void
  ): void {
    if (this.roadVehicles.length === 0 || this.roadSet.size === 0) return;

    const netVer = roadNet?.networkVersion ?? 1;

    // ---- Spatial index: tile -> vehicles occupying it ----------------------
    const tileBuckets = new Map<string, RoadVehicleAgent[]>();
    for (const v of this.roadVehicles) {
      if (v.parked) continue;
      const key = `${Math.round(v.gx)}:${Math.round(v.gy)}`;
      let list = tileBuckets.get(key);
      if (!list) {
        list = [];
        tileBuckets.set(key, list);
      }
      list.push(v);
    }

    // Same-edge ordering map: lets a follower reason about the vehicle directly
    // ahead even when both are mid-edge (tile buckets alone cannot express that).
    this.edgeOccupation.clear();
    for (const v of this.roadVehicles) {
      if (v.parked) continue;
      if (v.nextGx === v.prevGx && v.nextGy === v.prevGy) continue;
      const k = `${v.prevGx}:${v.prevGy}>${v.nextGx}:${v.nextGy}`;
      const list = this.edgeOccupation.get(k);
      if (list) list.push(v);
      else this.edgeOccupation.set(k, [v]);
    }

    // Intersection reservations must expire so a jam can always clear.
    for (const [key, timer] of this.junctionHoldTimers.entries()) {
      const next = timer - dtSec;
      if (next <= 0) {
        this.junctionHoldTimers.delete(key);
        this.junctionReservations.delete(key);
      } else {
        this.junctionHoldTimers.set(key, next);
      }
    }

    for (const veh of this.roadVehicles) {
      const tx = Math.round(veh.gx);
      const ty = Math.round(veh.gy);

      // Parked vehicles are inert: they keep their cargo claim/timeout ticking but
      // never occupy a lane, so an idle fleet cannot gridlock an arterial.
      if (veh.parked) {
        veh.speed = 0;
        veh.waitTimer -= dtSec;
        if (veh.waitTimer <= 0) {
          veh.parked = false;
          this.assignTrip(veh, state, chunks, roadNet);
        }
        continue;
      }

      // ---- Off-network recovery (road removed underneath the vehicle) ----
      if (!this.roadSet.has(`${tx}:${ty}`)) {
        this.rerouteOrRecover(veh, state, chunks, roadNet);
        continue;
      }

      // ---- Stationary states --------------------------------------------
      if (veh.state === 'loading' || veh.state === 'unloading' || veh.state === 'idle') {
        veh.speed = 0;
        veh.waitTimer -= dtSec;
        if (veh.waitTimer <= 0) {
          if (veh.state === 'unloading') {
            this.applyDeliveryCompletion(veh, state, onEvent);
            veh.returning = !veh.returning;
            if (veh.returning) {
              veh.cargoAmount = 0;
              veh.cargoResource = undefined;
            }
          }
          this.assignTrip(veh, state, chunks, roadNet);
        }
        continue;
      }

      // ---- Route invalidation after network edits -----------------------
      if (roadNet && veh.routeVersion !== netVer) {
        let routeIntact = veh.route.length > 0 && veh.routeIdx < veh.route.length;
        if (routeIntact) {
          const lookaheadEnd = Math.min(veh.route.length, veh.routeIdx + 8);
          let px = tx;
          let py = ty;
          for (let i = veh.routeIdx; i < lookaheadEnd; i++) {
            const wp = veh.route[i];
            if (!PathfindingSystem.isEdgeTraversable(px, py, wp.gx, wp.gy, chunks, 'vehicle')) {
              routeIntact = false;
              break;
            }
            px = wp.gx;
            py = wp.gy;
          }
        }
        if (routeIntact) {
          veh.routeVersion = netVer;
        } else {
          this.rerouteOrRecover(veh, state, chunks, roadNet);
          continue;
        }
      }

      // ---- Pick the next edge when standing on a node -------------------
      if (veh.progress >= 1 || (veh.nextGx === veh.prevGx && veh.nextGy === veh.prevGy)) {
        if (veh.routeIdx >= veh.route.length) {
          // Reached the end of the route: unload, then return trip.
          veh.state = 'unloading';
          veh.waitTimer = veh.returning ? 0.55 : 0.85;
          veh.speed = 0;
          continue;
        }

        const wp = veh.route[veh.routeIdx];
        const dx = wp.gx - tx;
        const dy = wp.gy - ty;

        if (Math.abs(dx) + Math.abs(dy) !== 1) {
          this.rerouteOrRecover(veh, state, chunks, roadNet);
          continue;
        }

        if (!PathfindingSystem.isEdgeTraversable(tx, ty, wp.gx, wp.gy, chunks, 'vehicle')) {
          this.rerouteOrRecover(veh, state, chunks, roadNet);
          continue;
        }

        // ---- Road suitability: heavy vehicles refuse to shortcut ---------
        const { chunk: nextChunk, index: nextIndex } = chunks.getTile(wp.gx, wp.gy);
        const nextRoadType = nextChunk.roadType[nextIndex] as RoadType;
        if (!isRoadAllowedForVehicle(nextRoadType, veh.vehicleClass) && veh.vehicleClass !== 'emergency') {
          // Try to reroute rather than squeezing a truck down a residential lane.
          this.rerouteOrRecover(veh, state, chunks, roadNet);
          continue;
        }

        // ---- Traffic signals --------------------------------------------
        if (roadNet && veh.vehicleClass !== 'emergency') {
          const sig = roadNet.getSignalState(wp.gx, wp.gy, dx, dy, simTimeSec, chunks);
          if (sig === 'red') {
            veh.state = 'waiting_signal';
            veh.speed = 0;
            // A red light is normal, not a block. Wait it out; only give up if the
            // signal never releases (2 full cycles), which means the light is broken.
            veh.blockedSec += dtSec;
            if (veh.blockedSec > 36) {
              veh.blockedSec = 0;
              this.rerouteOrRecover(veh, state, chunks, roadNet);
            }
            continue;
          }
        }

        // ---- Intersection occupancy: never enter a blocked junction ------
        const junction = roadNet?.getJunction(wp.gx, wp.gy);
        if (junction && veh.blockedSec < 5) {
          const key = `${wp.gx}:${wp.gy}`;
          const holder = this.junctionReservations.get(key);
          if (holder !== undefined && holder !== veh.id) {
            veh.state = 'waiting_traffic';
            veh.speed = 0;
            veh.blockedSec += dtSec;
            continue;
          }
          // Refuse to enter when the far side of the junction is congested.
          const nextOcc = tileBuckets.get(`${wp.gx}:${wp.gy}`);
          const cap = Math.max(1, getRoadProperties(nextRoadType).lanesPerDirection) + 1;
          if (nextOcc && nextOcc.length >= cap) {
            veh.state = 'waiting_traffic';
            veh.speed = 0;
            veh.blockedSec += dtSec;
            continue;
          }
          this.junctionReservations.set(key, veh.id);
          this.junctionHoldTimers.set(key, 2.5);
        }

        // ---- Headway: don't drive into an occupied next tile -------------
        const nextOcc = tileBuckets.get(`${wp.gx}:${wp.gy}`);
        if (nextOcc && nextOcc.length > 0 && veh.blockedSec < 6) {
          const caps = Math.max(1, getRoadProperties(nextRoadType).lanesPerDirection) + 1;
          const sameDirAhead = nextOcc.filter(
            (o) => o.id !== veh.id && o.vx === dx && o.vy === dy && o.progress < 0.5
          );
          if (nextOcc.length >= caps || sameDirAhead.length > 0) {
            veh.state = 'waiting_traffic';
            veh.speed = Math.max(0, veh.speed - 8 * dtSec);
            veh.blockedSec += dtSec;
            continue;
          }
        }

        veh.prevGx = tx;
        veh.prevGy = ty;
        veh.nextGx = wp.gx;
        veh.nextGy = wp.gy;
        veh.vx = dx;
        veh.vy = dy;
        veh.facing = dx - dy >= 0 ? 1 : -1;
        veh.progress = 0;
        veh.state = 'en_route';
        veh.blockedSec = 0;
      }

      const dirX = veh.nextGx - veh.prevGx;
      const dirY = veh.nextGy - veh.prevGy;
      if (Math.abs(dirX) + Math.abs(dirY) !== 1) {
        this.rerouteOrRecover(veh, state, chunks, roadNet);
        continue;
      }

      // ---- Safe following distance behind the leader on the same edge -------
      // Vehicles share an edge but never share a position: the follower is capped
      // to the leader's speed and stopped completely inside the safety gap.
      // Coincident vehicles are ordered deterministically by id so they always
      // separate instead of drawing on top of each other.
      const SAFE_GAP = 0.34;
      const HARD_GAP = 0.22;
      let leaderCapSpeed = Infinity;
      const edgeKey = `${veh.prevGx}:${veh.prevGy}>${veh.nextGx}:${veh.nextGy}`;
      for (const peer of this.edgeOccupation.get(edgeKey) ?? []) {
        if (peer.id === veh.id) continue;
        const ahead = peer.progress > veh.progress + 1e-6 || (Math.abs(peer.progress - veh.progress) <= 1e-6 && peer.id < veh.id);
        if (!ahead) continue;
        const gap = peer.progress - veh.progress;
        if (gap <= HARD_GAP) {
          leaderCapSpeed = 0;
        } else if (gap < SAFE_GAP) {
          const t = (gap - HARD_GAP) / (SAFE_GAP - HARD_GAP);
          leaderCapSpeed = Math.min(leaderCapSpeed, peer.speed * (0.35 + t * 0.55));
        } else if (gap < SAFE_GAP + 0.3) {
          leaderCapSpeed = Math.min(leaderCapSpeed, peer.speed * 0.95);
        }
      }

      // ---- Speed: road geometry + quality + congestion -------------------
      const { chunk, index } = chunks.getTile(tx, ty);
      const rt = chunk.roadType[index] as RoadType;
      const props = getRoadProperties(rt);
      const roadSpeedMult = ROADS[rt]?.speedMultiplier ?? 1.0;
      const cong = roadNet?.getTileCongestion(tx, ty) ?? 0;
      const laneCount = Math.max(1, props.lanesPerDirection);
      // Wider roads relieve congestion pressure rather than adding it.
      const laneRelief = 1 + Math.min(0.35, (laneCount - 1) * 0.12);
      const qualityFactor = 0.75 + props.qualityBase * 0.3;
      const suitabilityFactor = isRoadAllowedForVehicle(rt, veh.vehicleClass)
        ? 1
        : veh.vehicleClass === 'heavy_truck'
          ? 0.55
          : 0.85;

      const desiredSpeed = Math.min(
        leaderCapSpeed,
        veh.maxSpeed *
          Math.min(2.4, roadSpeedMult) *
          Math.max(0.4, 1 - cong * 0.5) *
          laneRelief *
          qualityFactor *
          suitabilityFactor
      );

      if (desiredSpeed <= 0.05) {
        veh.speed = Math.max(0, veh.speed - 8 * dtSec);
        veh.state = 'waiting_traffic';
        veh.blockedSec += dtSec;
        if (veh.blockedSec > 5) {
          // Deadlock breaker: force a reroute (or recovery) so jams always clear.
          veh.blockedSec = 0;
          this.rerouteOrRecover(veh, state, chunks, roadNet);
        }
        continue;
      }

      veh.state = 'en_route';
      veh.blockedSec = 0;
      veh.speed =
        veh.speed < desiredSpeed
          ? Math.min(desiredSpeed, veh.speed + 5.5 * dtSec)
          : Math.max(desiredSpeed, veh.speed - 7.0 * dtSec);

      veh.progress = Math.min(1, veh.progress + veh.speed * dtSec);
      veh.gx = veh.prevGx + dirX * veh.progress;
      veh.gy = veh.prevGy + dirY * veh.progress;

      // Keep the vehicle exactly on its lane path (never on the sidewalk).
      const laneIndex = LogisticsAndTransportSystem.getLaneIndex(
        tx,
        ty,
        dirX,
        dirY,
        veh.id,
        chunks
      );
      veh.laneOffset = LogisticsAndTransportSystem.laneOffsetFor(veh.id, laneCount, laneIndex, props.widthClass);

      if (veh.progress >= 1) {
        veh.gx = veh.nextGx;
        veh.gy = veh.nextGy;
        veh.routeIdx += 1;
        const key = `${veh.nextGx}:${veh.nextGy}`;
        if (this.junctionReservations.get(key) === veh.id) {
          this.junctionReservations.delete(key);
          this.junctionHoldTimers.delete(key);
        }
      }
    }
  }
}
