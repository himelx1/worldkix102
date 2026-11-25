import { BUILDINGS, getBuildingFootprint, getBuildingLevelMultiplier } from '../data/buildings.data';
import type { ResourceId } from '../data/resources.data';
import { getRoadProperties, ROADS, RoadType } from '../data/roads.data';
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
  public readonly loggingTrucks: LoggingTruckAgent[] = [];
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
    this.loggingTrucks.length = 0;
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
      this.syncLoggingTrucks(state, chunks);
      this.syncTrains(state);
      this.syncRoadVehicles(state, chunks, roadNet);
    }

    this.stepLoggingTrucks(dtSec, state, chunks, roadNet, onEvent, forestry);
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
        for (const lt of this.loggingTrucks) {
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

  private syncLoggingTrucks(state: WorldEngineState, chunks: ChunkManager): void {
    const factories = state.buildings.filter((b) => {
      const def = BUILDINGS[b.defId];
      return def?.isAutomatedLogging && b.status !== 'constructing' && b.enabled;
    });

    const activeFactoryIds = new Set(factories.map((f) => f.id));
    for (let i = this.loggingTrucks.length - 1; i >= 0; i--) {
      if (!activeFactoryIds.has(this.loggingTrucks[i].factoryId)) {
        this.loggingTrucks.splice(i, 1);
      }
    }

    for (const factory of factories) {
      const def = BUILDINGS[factory.defId]!;
      const targetTrucks = def.truckCapacity ?? 10;
      const existing = this.loggingTrucks.filter((t) => t.factoryId === factory.id);
      const fp = getBuildingFootprint(def, factory.rotation ?? 0);
      const cx = factory.gx + fp.width * 0.5;
      const cy = factory.gy + fp.height * 0.5;

      // Seed nearby forest logging permits once if none exist nearby so trucks start immediately
      if (existing.length === 0) {
        let hasPermitted = false;
        outer: for (let dy = -10; dy <= 10; dy++) {
          for (let dx = -10; dx <= 10; dx++) {
            if (chunks.isLoggingPermitted(Math.round(cx) + dx, Math.round(cy) + dy)) {
              hasPermitted = true;
              break outer;
            }
          }
        }
        if (!hasPermitted) {
          chunks.autoPermitForestForFactory(Math.round(cx), Math.round(cy), 10);
        }
      }

      const entrances = PathfindingSystem.findBuildingEntrances(factory, chunks, 'vehicle');
      const spawnPt = entrances.length > 0 ? entrances[0] : { gx: cx, gy: cy };
      const cargoCapacity = Math.max(8, Math.round(8 * getBuildingLevelMultiplier(factory.level, def)));

      while (existing.length < targetTrucks) {
        const truck: LoggingTruckAgent = {
          id: this.nextId++,
          factoryId: factory.id,
          gx: spawnPt.gx,
          gy: spawnPt.gy,
          targetGx: spawnPt.gx,
          targetGy: spawnPt.gy,
          state: 'idle_at_factory',
          cargoTimber: 0,
          cargoCapacity,
          harvestTimer: 0.25 + (existing.length % 5) * 0.25,
          facing: 1,
          route: undefined,
          routeIdx: 0,
          routeVersion: 0,
          laneOffset: 0,
          vx: 0,
          vy: 0,
          onRoad: entrances.length > 0,
          statusReason: entrances.length > 0 ? 'Ready for dispatch' : 'Blocked: Connect a road adjacent to factory',
        };
        this.loggingTrucks.push(truck);
        existing.push(truck);
      }
      for (const t of existing) {
        t.cargoCapacity = cargoCapacity;
      }
    }

    state.loggingStats ??= {
      harvestedTrees: 0,
      factoryTimberStock: 0,
      dailyTimberProduction: 0,
      activeTrucks: 0,
      permittedForestTiles: 0,
    };
    state.loggingStats.activeTrucks = this.loggingTrucks.length;
    state.loggingStats.permittedForestTiles = chunks.countLoggingPermittedTiles();
    state.loggingStats.factoryTimberStock = Math.round(state.resources.wood ?? 0);
    state.loggingStats.dailyTimberProduction = this.harvestedToday;
  }

  private findReachableTreeAndRoad(
    factory: BuildingInstance,
    chunks: ChunkManager,
    reservedTrees: Set<string>,
    roadNet?: RoadNetworkSystem,
    originRoad?: { gx: number; gy: number },
    maxTreeDistFromOrigin = 18
  ): {
    tree?: { gx: number; gy: number };
    stopRoad?: { gx: number; gy: number };
    entrance?: { gx: number; gy: number };
    path?: Array<{ gx: number; gy: number }>;
    reason?: string;
  } {
    const def = BUILDINGS[factory.defId];
    const fp = def ? getBuildingFootprint(def, factory.rotation ?? 0) : { width: 3, height: 3 };
    const cx = Math.round(factory.gx + fp.width * 0.5);
    const cy = Math.round(factory.gy + fp.height * 0.5);

    const entrances = originRoad
      ? [originRoad]
      : PathfindingSystem.findBuildingEntrances(factory, chunks, 'vehicle');
    if (entrances.length === 0) {
      return { reason: 'Blocked: Connect a drivable road to the Logging Factory' };
    }

    const refX = originRoad ? originRoad.gx : cx;
    const refY = originRoad ? originRoad.gy : cy;
    const r = maxTreeDistFromOrigin;
    const candidates: Array<{ gx: number; gy: number; score: number }> = [];

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const tx = refX + dx;
        const ty = refY + dy;
        const key = `${tx}:${ty}`;
        if (reservedTrees.has(key)) continue;

        const { chunk, index } = chunks.getTile(tx, ty);
        const ft = chunk.featureType[index] as FeatureType;
        if (!isTreeFeature(ft) || ft === FeatureType.Sapling) continue;

        const unlocked = (chunk.flags[index] & TileFlag.Unlocked) !== 0;
        const permitted = (chunk.flags[index] & TileFlag.LoggingPermit) !== 0;
        if (!unlocked && !permitted) continue;

        candidates.push({
          gx: tx,
          gy: ty,
          score: Math.hypot(dx, dy) - (permitted ? 2.5 : 0),
        });
      }
    }

    if (candidates.length === 0) {
      return { reason: 'Waiting for available forest trees or regrowth' };
    }

    candidates.sort((a, b) => a.score - b.score);
    const congestionMap = roadNet?.getTileCongestionMap();
    let sawUnconnectedCandidate = false;

    for (const cand of candidates.slice(0, 18)) {
      const roadStops: Array<{ gx: number; gy: number; dist: number }> = [];
      for (let rdy = -5; rdy <= 5; rdy++) {
        for (let rdx = -5; rdx <= 5; rdx++) {
          const rx = cand.gx + rdx;
          const ry = cand.gy + rdy;
          if (!PathfindingSystem.isTilePassable(rx, ry, chunks, 'vehicle')) continue;
          const d = Math.hypot(rdx, rdy);
          if (d <= 5.2) {
            roadStops.push({ gx: rx, gy: ry, dist: d });
          }
        }
      }
      if (roadStops.length === 0) {
        sawUnconnectedCandidate = true;
        continue;
      }
      roadStops.sort((a, b) => a.dist - b.dist);

      for (const stop of roadStops.slice(0, 3)) {
        for (const ent of entrances.slice(0, 2)) {
          if (ent.gx === stop.gx && ent.gy === stop.gy) {
            return {
              tree: { gx: cand.gx, gy: cand.gy },
              stopRoad: { gx: stop.gx, gy: stop.gy },
              entrance: ent,
              path: [],
            };
          }
          const path = PathfindingSystem.findPath(
            ent.gx,
            ent.gy,
            stop.gx,
            stop.gy,
            chunks,
            'vehicle',
            420,
            { vehicleClass: 'heavy_truck', congestionMap }
          );
          if (path && path.length > 0) {
            return {
              tree: { gx: cand.gx, gy: cand.gy },
              stopRoad: { gx: stop.gx, gy: stop.gy },
              entrance: ent,
              path,
            };
          }
        }
      }
      sawUnconnectedCandidate = true;
    }

    return {
      reason: sawUnconnectedCandidate
        ? 'Blocked: Place a Road Connector to link owned roads to forest roads'
        : 'Waiting for available forest trees or regrowth',
    };
  }

  private findRouteBetweenBuildings(
    fromGx: number,
    fromGy: number,
    destBuilding: BuildingInstance,
    chunks: ChunkManager,
    roadNet?: RoadNetworkSystem
  ): Array<{ gx: number; gy: number }> | null {
    const startX = Math.round(fromGx);
    const startY = Math.round(fromGy);
    if (!this.roadSet.has(`${startX}:${startY}`)) return null;
    const destEntrances = PathfindingSystem.findBuildingEntrances(destBuilding, chunks, 'vehicle');
    const congestionMap = roadNet?.getTileCongestionMap();
    for (const ent of destEntrances.slice(0, 4)) {
      if (ent.gx === startX && ent.gy === startY) return [];
      const path = PathfindingSystem.findPath(
        startX,
        startY,
        ent.gx,
        ent.gy,
        chunks,
        'vehicle',
        420,
        { vehicleClass: 'heavy_truck', congestionMap }
      );
      if (path && path.length > 0) return path;
    }
    return null;
  }

  private scheduleRegrowthFallback(
    gx: number,
    gy: number,
    ft: FeatureType,
    state: WorldEngineState,
    forestry?: ForestrySystem
  ): void {
    if (forestry) {
      forestry.scheduleTreeRegrowth(gx, gy, ft, state);
      return;
    }
    const species = TREE_SPECIES[ft];
    if (!species || species.woodYield <= 0 || ft === FeatureType.Sapling) return;
    state.treeRegrowthQueue ??= [];
    const idx = state.treeRegrowthQueue.findIndex((e) => e.gx === gx && e.gy === gy);
    const entry = {
      gx,
      gy,
      species: ft,
      saplingAtTick: state.tick + 12,
      readyAtTick: state.tick + 48,
    };
    if (idx >= 0) state.treeRegrowthQueue[idx] = entry;
    else state.treeRegrowthQueue.push(entry);
  }

  private stepLoggingTrucks(
    dtSec: number,
    state: WorldEngineState,
    chunks: ChunkManager,
    roadNet?: RoadNetworkSystem,
    onEvent?: (ev: TransportDeliveryEvent) => void,
    forestry?: ForestrySystem
  ): void {
    if (this.loggingTrucks.length === 0) return;

    const sawmills = state.buildings.filter(
      (b) => b.status !== 'constructing' && b.enabled && SAWMILL_IDS.has(b.defId)
    );

    const reservedTrees = new Set<string>();
    for (const t of this.loggingTrucks) {
      if (t.reservedTreeGx !== undefined && t.reservedTreeGy !== undefined) {
        reservedTrees.add(`${t.reservedTreeGx}:${t.reservedTreeGy}`);
      }
    }

    for (const truck of this.loggingTrucks) {
      if (truck.state === 'chopping') {
        truck.state = 'worker_chopping';
        truck.workerPhase ??= 'chopping';
        truck.workerGx ??= truck.targetGx;
        truck.workerGy ??= truck.targetGy;
      }

      const factory = state.buildings.find((b) => b.id === truck.factoryId);
      if (!factory || !factory.enabled) continue;
      const def = BUILDINGS[factory.defId];
      if (!def) continue;
      const fp = getBuildingFootprint(def, factory.rotation ?? 0);
      const homeGx = factory.gx + fp.width * 0.5;
      const homeGy = factory.gy + fp.height * 0.5;
      const cargoCapacity = truck.cargoCapacity ?? Math.max(8, Math.round(8 * getBuildingLevelMultiplier(factory.level, def)));
      const workerRatio = Math.max(0.2, Math.min(1.2, (factory.assignedWorkers || 1) / Math.max(1, def.maxWorkers)));
      const baseSpeed = 2.6 * (0.7 + workerRatio * 0.6);

      // 1. Disembarked worker chopping loop while truck remains parked on the road
      if (truck.state === 'worker_chopping') {
        truck.onRoad = this.roadSet.has(`${Math.round(truck.gx)}:${Math.round(truck.gy)}`);
        truck.vx = 0;
        truck.vy = 0;
        truck.workerPhase ??= 'walking_to_tree';
        truck.workerGx ??= truck.gx;
        truck.workerGy ??= truck.gy;

        if (truck.workerPhase === 'walking_to_tree') {
          const tx = truck.reservedTreeGx ?? truck.targetGx;
          const ty = truck.reservedTreeGy ?? truck.targetGy;
          const dx = tx - truck.workerGx;
          const dy = ty - truck.workerGy;
          const dist = Math.hypot(dx, dy);
          if (dist > 0.14) {
            const step = Math.min(dist, 1.9 * dtSec);
            truck.workerGx += (dx / dist) * step;
            truck.workerGy += (dy / dist) * step;
            truck.workerFacing = dx - dy >= 0 ? 1 : -1;
            truck.statusReason = 'Forestry worker walking to tree';
            continue;
          }
          truck.workerGx = tx;
          truck.workerGy = ty;
          truck.workerPhase = 'chopping';
          truck.harvestTimer = 1.0;
          truck.statusReason = 'Forestry worker chopping timber';
          continue;
        }

        if (truck.workerPhase === 'chopping') {
          truck.harvestTimer -= dtSec;
          if (truck.harvestTimer > 0) continue;

          const treeX = Math.round(truck.reservedTreeGx ?? truck.targetGx);
          const treeY = Math.round(truck.reservedTreeGy ?? truck.targetGy);
          const { cx, cy, index } = gridToChunk(treeX, treeY);
          const chunk = chunks.getOrCreateChunk(cx, cy);
          const ft = chunk.featureType[index] as FeatureType;
          const unlocked = (chunk.flags[index] & TileFlag.Unlocked) !== 0;
          const permitted = (chunk.flags[index] & TileFlag.LoggingPermit) !== 0;

          if (isTreeFeature(ft) && ft !== FeatureType.Sapling && (unlocked || permitted)) {
            const species = TREE_SPECIES[ft];
            chunk.featureType[index] = FeatureType.None;
            chunk.featureHp[index] = 0;
            chunks.markChunkModified(cx, cy);
            this.scheduleRegrowthFallback(treeX, treeY, ft, state, forestry);

            const lvlMult = getBuildingLevelMultiplier(factory.level, def);
            const timber = Math.max(2, Math.round((species?.woodYield ?? 4) * lvlMult));
            truck.cargoTimber = Math.min(cargoCapacity, truck.cargoTimber + timber);
            state.stats.treesCut += 1;
            state.loggingStats ??= {
              harvestedTrees: 0,
              factoryTimberStock: 0,
              dailyTimberProduction: 0,
              activeTrucks: this.loggingTrucks.length,
              permittedForestTiles: 0,
            };
            state.loggingStats.harvestedTrees += 1;
          }

          reservedTrees.delete(`${treeX}:${treeY}`);
          truck.reservedTreeGx = undefined;
          truck.reservedTreeGy = undefined;
          truck.workerPhase = 'returning_to_truck';
          truck.statusReason = 'Worker loading timber into truck';
          continue;
        }

        // returning_to_truck
        const dx = truck.gx - truck.workerGx;
        const dy = truck.gy - truck.workerGy;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.14) {
          const step = Math.min(dist, 1.75 * dtSec);
          truck.workerGx += (dx / dist) * step;
          truck.workerGy += (dy / dist) * step;
          truck.workerFacing = dx - dy >= 0 ? 1 : -1;
          continue;
        }

        truck.workerGx = truck.gx;
        truck.workerGy = truck.gy;

        // If truck still has cargo capacity, check for another adjacent tree near current road stop
        if (truck.cargoTimber < cargoCapacity && this.roadSet.has(`${Math.round(truck.gx)}:${Math.round(truck.gy)}`)) {
          const nearby = this.findReachableTreeAndRoad(
            factory,
            chunks,
            reservedTrees,
            roadNet,
            { gx: Math.round(truck.gx), gy: Math.round(truck.gy) },
            5
          );
          if (nearby.tree && (!nearby.path || nearby.path.length === 0)) {
            reservedTrees.add(`${nearby.tree.gx}:${nearby.tree.gy}`);
            truck.reservedTreeGx = nearby.tree.gx;
            truck.reservedTreeGy = nearby.tree.gy;
            truck.targetGx = nearby.tree.gx;
            truck.targetGy = nearby.tree.gy;
            truck.workerPhase = 'walking_to_tree';
            truck.statusReason = 'Forestry worker walking to next tree';
            continue;
          }
        }

        // Otherwise board truck and return strictly along connected roads to factory
        truck.workerPhase = undefined;
        truck.workerGx = undefined;
        truck.workerGy = undefined;
        const backRoute = this.findRouteBetweenBuildings(truck.gx, truck.gy, factory, chunks, roadNet);
        if (backRoute) {
          truck.state = 'to_factory';
          truck.targetGx = homeGx;
          truck.targetGy = homeGy;
          truck.route = backRoute;
          truck.routeIdx = 0;
          truck.routeVersion = roadNet?.networkVersion ?? 1;
          truck.statusReason = 'Returning timber via road network';
        } else {
          truck.state = 'blocked';
          truck.route = undefined;
          truck.harvestTimer = 1.8;
          truck.statusReason = 'Blocked: Road or Connector back to factory missing';
        }
        continue;
      }

      // 2. Idle or blocked at factory/road -> seek a valid road + Connector route to an unreserved tree
      if (truck.state === 'idle_at_factory' || truck.state === 'blocked') {
        truck.harvestTimer -= dtSec;
        if (truck.harvestTimer > 0) continue;

        // If blocked while carrying timber on a road, try resuming route back to factory first
        if (truck.cargoTimber > 0 && this.roadSet.has(`${Math.round(truck.gx)}:${Math.round(truck.gy)}`)) {
          const recovery = this.findRouteBetweenBuildings(truck.gx, truck.gy, factory, chunks, roadNet);
          if (recovery) {
            truck.state = 'to_factory';
            truck.route = recovery;
            truck.routeIdx = 0;
            truck.routeVersion = roadNet?.networkVersion ?? 1;
            truck.statusReason = 'Resumed road route to factory';
            continue;
          }
        }

        const plan = this.findReachableTreeAndRoad(factory, chunks, reservedTrees, roadNet);
        if (plan.tree && plan.stopRoad && plan.entrance && plan.path) {
          reservedTrees.add(`${plan.tree.gx}:${plan.tree.gy}`);
          truck.reservedTreeGx = plan.tree.gx;
          truck.reservedTreeGy = plan.tree.gy;
          truck.stopRoadGx = plan.stopRoad.gx;
          truck.stopRoadGy = plan.stopRoad.gy;
          truck.targetGx = plan.stopRoad.gx;
          truck.targetGy = plan.stopRoad.gy;
          truck.gx = plan.entrance.gx;
          truck.gy = plan.entrance.gy;
          truck.onRoad = true;
          truck.route = plan.path;
          truck.routeIdx = 0;
          truck.routeVersion = roadNet?.networkVersion ?? 1;
          truck.state = 'to_forest';
          truck.statusReason = 'Driving on roads to harvest site';
        } else {
          truck.state = 'blocked';
          truck.harvestTimer = 2.0;
          truck.statusReason = plan.reason ?? 'Blocked: No connected road route';
        }
        continue;
      }

      // 3. Strictly road-following driving states: to_forest, to_factory, delivering_sawmill
      if (roadNet && truck.routeVersion !== roadNet.networkVersion) {
        if (truck.state === 'to_forest' && truck.stopRoadGx !== undefined && truck.stopRoadGy !== undefined) {
          const curTile = { gx: Math.round(truck.gx), gy: Math.round(truck.gy) };
          const reroute = this.roadSet.has(`${curTile.gx}:${curTile.gy}`)
            ? PathfindingSystem.findPath(curTile.gx, curTile.gy, truck.stopRoadGx, truck.stopRoadGy, chunks, 'vehicle', 420, {
                vehicleClass: 'heavy_truck',
                congestionMap: roadNet.getTileCongestionMap(),
              })
            : null;
          if (reroute) {
            truck.route = reroute;
            truck.routeIdx = 0;
            truck.routeVersion = roadNet.networkVersion;
          } else {
            if (truck.reservedTreeGx !== undefined && truck.reservedTreeGy !== undefined) {
              reservedTrees.delete(`${truck.reservedTreeGx}:${truck.reservedTreeGy}`);
              truck.reservedTreeGx = undefined;
              truck.reservedTreeGy = undefined;
            }
            truck.route = undefined;
            truck.state = 'blocked';
            truck.harvestTimer = 1.6;
            truck.statusReason = 'Blocked: Road or Connector disconnected';
            continue;
          }
        } else if (truck.state === 'to_factory') {
          const back = this.findRouteBetweenBuildings(truck.gx, truck.gy, factory, chunks, roadNet);
          if (back) {
            truck.route = back;
            truck.routeIdx = 0;
            truck.routeVersion = roadNet.networkVersion;
          } else {
            truck.route = undefined;
            truck.state = 'blocked';
            truck.harvestTimer = 1.6;
            truck.statusReason = 'Blocked: Road back to factory disconnected';
            continue;
          }
        }
      }

      if (truck.route && (truck.routeIdx ?? 0) < truck.route.length) {
        const curGx = Math.round(truck.gx);
        const curGy = Math.round(truck.gy);
        const wp = truck.route[truck.routeIdx ?? 0];
        const wpKey = `${wp.gx}:${wp.gy}`;
        const manhattan = Math.abs(wp.gx - curGx) + Math.abs(wp.gy - curGy);
        const validEdge =
          this.roadSet.has(wpKey) &&
          (manhattan === 0 ||
            (manhattan === 1 && PathfindingSystem.isEdgeTraversable(curGx, curGy, wp.gx, wp.gy, chunks, 'vehicle')));

        if (!validEdge) {
          truck.route = undefined;
          truck.routeIdx = 0;
          truck.state = 'blocked';
          truck.harvestTimer = 1.5;
          truck.statusReason = 'Blocked: Road path severed';
          continue;
        }

        const dx = wp.gx - truck.gx;
        const dy = wp.gy - truck.gy;
        const dist = Math.hypot(dx, dy);
        truck.onRoad = this.roadSet.has(`${curGx}:${curGy}`);
        const speed = baseSpeed * 1.25;
        if (dist > 0.12) {
          const step = Math.min(dist, speed * dtSec);
          const vx = dx / dist;
          const vy = dy / dist;
          truck.gx += vx * step;
          truck.gy += vy * step;
          truck.vx = vx;
          truck.vy = vy;
          truck.facing = vx - vy >= 0 ? 1 : -1;
          truck.laneOffset = truck.onRoad
            ? getLaneOffsetForTile(Math.round(truck.gx), Math.round(truck.gy), truck.id, chunks)
            : 0;
          continue;
        }
        truck.gx = wp.gx;
        truck.gy = wp.gy;
        truck.routeIdx = (truck.routeIdx ?? 0) + 1;
        if ((truck.routeIdx ?? 0) < truck.route.length) {
          continue;
        }
      }

      // Arrived at route destination! (Or 0-length route when already adjacent to target)
      if (!truck.route) {
        truck.state = 'blocked';
        truck.harvestTimer = 1.5;
        truck.statusReason = 'Blocked: No road route available';
        continue;
      }

      truck.vx = 0;
      truck.vy = 0;

      if (truck.state === 'to_forest') {
        truck.onRoad = true;
        truck.state = 'worker_chopping';
        truck.workerPhase = 'walking_to_tree';
        truck.workerGx = truck.gx;
        truck.workerGy = truck.gy;
        truck.statusReason = 'Forestry worker walking to tree';
        continue;
      }

      if (truck.state === 'to_factory') {
        if (truck.cargoTimber > 0) {
          const added = ResourceSystem.addClamped(state, 'wood', truck.cargoTimber);
          factory.realizedOutputTotal = (factory.realizedOutputTotal ?? 0) + added;
          this.harvestedToday += truck.cargoTimber;
          state.loggingStats ??= {
            harvestedTrees: 0,
            factoryTimberStock: 0,
            dailyTimberProduction: 0,
            activeTrucks: this.loggingTrucks.length,
            permittedForestTiles: 0,
          };
          state.loggingStats.factoryTimberStock = Math.round(state.resources.wood ?? 0);
          state.loggingStats.dailyTimberProduction = this.harvestedToday;
          if (added > 0 && truck.id % 3 === 0) {
            onEvent?.({ gx: homeGx, gy: homeGy, label: `+${added} Timber`, color: '#a3e635' });
          }
        }
        truck.cargoTimber = 0;

        // Check if a reachable sawmill on the same road network wants a shipment
        if (sawmills.length > 0 && truck.id % 3 === 0 && (state.resources.wood ?? 0) >= 4) {
          const mill = sawmills[truck.id % sawmills.length];
          const millRoute = this.findRouteBetweenBuildings(truck.gx, truck.gy, mill, chunks, roadNet);
          if (millRoute && millRoute.length > 0) {
            truck.cargoTimber = 4;
            truck.state = 'delivering_sawmill';
            truck.route = millRoute;
            truck.routeIdx = 0;
            truck.routeVersion = roadNet?.networkVersion ?? 1;
            truck.onRoad = true;
            truck.statusReason = 'Delivering timber to Sawmill';
            continue;
          }
        }

        truck.state = 'idle_at_factory';
        truck.onRoad = false;
        truck.harvestTimer = 0.5;
        truck.route = undefined;
        truck.statusReason = 'Unloaded timber at factory';
        continue;
      }

      if (truck.state === 'delivering_sawmill') {
        truck.cargoTimber = 0;
        if (sawmills.length > 0) {
          const mill = sawmills[truck.id % sawmills.length];
          if (mill.status === 'active') {
            mill.prodProgress = Math.min(0.98, mill.prodProgress + 0.12);
          }
        }
        const backRoute = this.findRouteBetweenBuildings(truck.gx, truck.gy, factory, chunks, roadNet);
        if (backRoute) {
          truck.state = 'to_factory';
          truck.route = backRoute;
          truck.routeIdx = 0;
          truck.routeVersion = roadNet?.networkVersion ?? 1;
          truck.statusReason = 'Returning empty from Sawmill';
        } else {
          truck.state = 'idle_at_factory';
          truck.route = undefined;
          truck.harvestTimer = 1.0;
        }
      }
    }
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
      this.roadVehicles.length = desiredKinds.length;
    }

    for (let i = 0; i < this.roadVehicles.length; i++) {
      const veh = this.roadVehicles[i];
      if (veh.kind !== desiredKinds[i]) {
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
      if (outKeys.length > 0) {
        cargoResource = outKeys[seed % outKeys.length];
        cargoAmount = 2;
      } else if (kind === 'cargo_truck') {
        cargoResource = CARGO_FALLBACK_RESOURCES[seed % CARGO_FALLBACK_RESOURCES.length];
        cargoAmount = 1;
      }
    }

    void state;
    void roadNet;
    return { source, dest, cargoResource, cargoAmount };
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

    veh.sourceBuildingId = source?.id;
    veh.destBuildingId = dest?.id;
    if (veh.returning) {
      veh.cargoResource = undefined;
      veh.cargoAmount = 0;
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
    veh.waitTimer = 1.5;
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

  private stepRoadVehicles(
    dtSec: number,
    state: WorldEngineState,
    chunks: ChunkManager,
    roadNet: RoadNetworkSystem | undefined,
    simTimeSec: number,
    onEvent?: (ev: TransportDeliveryEvent) => void
  ): void {
    if (this.roadVehicles.length === 0 || this.roadSet.size === 0) return;

    // Spatial bucket by integer grid tile for fast local following-distance & junction checks
    const tileBuckets = new Map<string, RoadVehicleAgent[]>();
    for (const v of this.roadVehicles) {
      const key = `${Math.round(v.gx)}:${Math.round(v.gy)}`;
      let list = tileBuckets.get(key);
      if (!list) {
        list = [];
        tileBuckets.set(key, list);
      }
      list.push(v);
    }

    const netVer = roadNet?.networkVersion ?? 1;

    for (const veh of this.roadVehicles) {
      const tx = Math.round(veh.gx);
      const ty = Math.round(veh.gy);

      if (!this.roadSet.has(`${tx}:${ty}`)) {
        this.rerouteOrRecover(veh, state, chunks, roadNet);
        continue;
      }

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

      // Dynamic route invalidation when network changes (new/removed roads or flipped one-way rules)
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

      // Pick next step if starting at a tile node
      if (veh.progress >= 1 || (veh.nextGx === veh.prevGx && veh.nextGy === veh.prevGy)) {
        if (veh.routeIdx >= veh.route.length) {
          veh.state = 'unloading';
          veh.waitTimer = veh.returning ? 0.6 : 0.9;
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

        // Traffic signal obedience at signalized intersections
        if (roadNet && veh.vehicleClass !== 'emergency') {
          const sig = roadNet.getSignalState(wp.gx, wp.gy, dx, dy, simTimeSec, chunks);
          if (sig === 'red') {
            veh.state = 'waiting_signal';
            veh.speed = 0;
            veh.blockedSec += dtSec;
            continue;
          }
        }

        // Intersection / next-tile occupancy yield check
        const nextOcc = tileBuckets.get(`${wp.gx}:${wp.gy}`);
        if (nextOcc && nextOcc.length > 0) {
          const { chunk, index } = chunks.getTile(wp.gx, wp.gy);
          const nrt = chunk.roadType[index] as RoadType;
          const cap = Math.max(1, getRoadProperties(nrt).lanesPerDirection) + 1;
          const blockedByAhead =
            nextOcc.length >= cap ||
            nextOcc.some(
              (other) =>
                other.id !== veh.id &&
                other.progress < 0.42 &&
                (other.vx !== dx || other.vy !== dy)
            );
          if (blockedByAhead && veh.blockedSec < 4.0) {
            veh.state = 'waiting_traffic';
            veh.speed = 0;
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

      // Safe following distance behind leader vehicle in the same lane/segment
      let leaderCapSpeed = Infinity;
      const localPeers = [
        ...(tileBuckets.get(`${veh.prevGx}:${veh.prevGy}`) ?? []),
        ...(tileBuckets.get(`${veh.nextGx}:${veh.nextGy}`) ?? []),
      ];
      for (const peer of localPeers) {
        if (peer.id === veh.id) continue;
        if (peer.prevGx === veh.prevGx && peer.prevGy === veh.prevGy && peer.nextGx === veh.nextGx && peer.nextGy === veh.nextGy) {
          const gap = peer.progress - veh.progress;
          if (gap > 0 && gap < 0.42) {
            leaderCapSpeed = Math.min(leaderCapSpeed, peer.speed * 0.85);
            if (gap < 0.25) {
              leaderCapSpeed = 0;
            }
          }
        }
      }

      const { chunk, index } = chunks.getTile(tx, ty);
      const rt = chunk.roadType[index] as RoadType;
      const roadSpeedMult = ROADS[rt]?.speedMultiplier ?? 1.0;
      const cong = roadNet?.getTileCongestion(tx, ty) ?? 0;
      const desiredSpeed = Math.min(
        leaderCapSpeed,
        veh.maxSpeed * Math.min(2.3, roadSpeedMult) * Math.max(0.45, 1 - cong * 0.45)
      );

      if (desiredSpeed <= 0.05) {
        veh.speed = Math.max(0, veh.speed - 7.5 * dtSec);
        veh.state = 'waiting_traffic';
        veh.blockedSec += dtSec;
        if (veh.blockedSec > 4.2) {
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
      veh.laneOffset = getLaneOffsetForTile(tx, ty, veh.id, chunks);

      if (veh.progress >= 1) {
        veh.gx = veh.nextGx;
        veh.gy = veh.nextGy;
        veh.routeIdx += 1;
      }
    }
  }
}
