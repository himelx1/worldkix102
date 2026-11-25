import { BUILDINGS, getBuildingFootprint, getBuildingLevelMultiplier } from '../data/buildings.data';
import { RoadType } from '../data/roads.data';
import { FeatureType, isTreeFeature, TREE_SPECIES } from '../data/trees.data';
import type { ChunkManager } from '../core/ChunkManager';
import {
  LoggingTruckAgent,
  RoadVehicleAgent,
  TileFlag,
  TrainAgent,
  WorldEngineState,
} from '../core/GameState';
import { CHUNK_SIZE, chunkToGrid, gridToChunk } from '../core/IsoMath';
import { ResourceSystem } from './ResourceSystem';

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

export class LogisticsAndTransportSystem {
  public readonly loggingTrucks: LoggingTruckAgent[] = [];
  public readonly trains: TrainAgent[] = [];
  public readonly roadVehicles: RoadVehicleAgent[] = [];

  private nextId = 1;
  private syncAccum = 0;
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
    this.harvestedToday = 0;
    this.lastDayReset = -1;
  }

  public update(
    dtSec: number,
    state: WorldEngineState,
    chunks: ChunkManager,
    onEvent?: (ev: TransportDeliveryEvent) => void
  ): void {
    const dayKey = state.year * 100 + state.dayInSeason;
    if (this.lastDayReset !== dayKey) {
      this.lastDayReset = dayKey;
      this.harvestedToday = 0;
    }

    this.syncAccum += dtSec;
    if (this.syncAccum >= 2.0 || (this.trains.length === 0 && this.loggingTrucks.length === 0 && this.syncAccum >= 0.4)) {
      this.syncAccum = 0;
      this.rebuildNetworkCache(chunks);
      this.syncLoggingTrucks(state, chunks);
      this.syncTrains(state);
      this.syncRoadVehicles(state);
    }

    this.stepLoggingTrucks(dtSec, state, chunks, onEvent);
    this.stepTrains(dtSec);
    this.stepRoadVehicles(dtSec);
  }

  private rebuildNetworkCache(chunks: ChunkManager): void {
    this.cachedRailTiles = [];
    this.cachedRoadTiles = [];
    this.railSet.clear();
    this.roadSet.clear();

    for (const chunk of chunks.getAllLoadedChunks()) {
      if (!chunk.isModified) continue;
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

      // Seed nearby forest logging permits once if none exist nearby so 10 trucks start immediately
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

      while (existing.length < targetTrucks) {
        const truck: LoggingTruckAgent = {
          id: this.nextId++,
          factoryId: factory.id,
          gx: cx,
          gy: cy,
          targetGx: cx,
          targetGy: cy,
          state: 'to_forest',
          cargoTimber: 0,
          harvestTimer: 0.4 + (existing.length % 5) * 0.25,
          facing: 1,
        };
        this.loggingTrucks.push(truck);
        existing.push(truck);
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

  private findPermittedTreeNear(
    fx: number,
    fy: number,
    chunks: ChunkManager,
    seedOffset: number
  ): { gx: number; gy: number } | null {
    const candidates: Array<{ gx: number; gy: number; dist: number; permitted: boolean }> = [];
    const r = 16;
    const baseX = Math.round(fx);
    const baseY = Math.round(fy);

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const tx = baseX + dx;
        const ty = baseY + dy;
        const { chunk, index } = chunks.getTile(tx, ty);
        const ft = chunk.featureType[index] as FeatureType;
        if (!isTreeFeature(ft)) continue;

        const unlocked = (chunk.flags[index] & TileFlag.Unlocked) !== 0;
        const permitted = (chunk.flags[index] & TileFlag.LoggingPermit) !== 0;
        // Strict locked-land logging rule: locked forest land is ONLY harvestable when explicitly permitted!
        if (!unlocked && !permitted) continue;

        candidates.push({
          gx: tx,
          gy: ty,
          dist: Math.hypot(dx, dy) - (permitted ? 2.5 : 0),
          permitted,
        });
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.dist - b.dist);
    const pickIdx = seedOffset % Math.min(8, candidates.length);
    return { gx: candidates[pickIdx].gx, gy: candidates[pickIdx].gy };
  }

  private stepLoggingTrucks(
    dtSec: number,
    state: WorldEngineState,
    chunks: ChunkManager,
    onEvent?: (ev: TransportDeliveryEvent) => void
  ): void {
    if (this.loggingTrucks.length === 0) return;

    const sawmills = state.buildings.filter(
      (b) => b.status !== 'constructing' && b.enabled && SAWMILL_IDS.has(b.defId)
    );

    for (const truck of this.loggingTrucks) {
      const factory = state.buildings.find((b) => b.id === truck.factoryId);
      if (!factory || !factory.enabled) continue;
      const def = BUILDINGS[factory.defId];
      if (!def) continue;
      const fp = getBuildingFootprint(def, factory.rotation ?? 0);
      const homeGx = factory.gx + fp.width * 0.5;
      const homeGy = factory.gy + fp.height * 0.5;

      // Worker efficiency scaling (min 15% autonomous drone base when under-staffed so 10 trucks visibly move)
      const workerRatio = Math.max(0.2, Math.min(1.2, (factory.assignedWorkers || 1) / Math.max(1, def.maxWorkers)));
      const speed = 2.6 * (0.7 + workerRatio * 0.6);

      if (truck.state === 'chopping') {
        truck.harvestTimer -= dtSec;
        if (truck.harvestTimer > 0) continue;

        // Harvest tree on permitted/unlocked tile WITHOUT unlocking land
        const { cx, cy, index } = gridToChunk(Math.round(truck.targetGx), Math.round(truck.targetGy));
        const chunk = chunks.getOrCreateChunk(cx, cy);
        const ft = chunk.featureType[index] as FeatureType;
        const unlocked = (chunk.flags[index] & TileFlag.Unlocked) !== 0;
        const permitted = (chunk.flags[index] & TileFlag.LoggingPermit) !== 0;

        if (isTreeFeature(ft) && (unlocked || permitted)) {
          const species = TREE_SPECIES[ft];
          chunk.featureType[index] = FeatureType.None;
          chunk.featureHp[index] = 0;
          chunks.markChunkModified(cx, cy);
          const lvlMult = getBuildingLevelMultiplier(factory.level, def);
          const timber = Math.max(2, Math.round((species?.woodYield ?? 4) * lvlMult));
          truck.cargoTimber = timber;
          state.stats.treesCut += 1;
          state.loggingStats ??= {
            harvestedTrees: 0,
            factoryTimberStock: 0,
            dailyTimberProduction: 0,
            activeTrucks: this.loggingTrucks.length,
            permittedForestTiles: 0,
          };
          state.loggingStats.harvestedTrees += 1;
        } else {
          truck.cargoTimber = 2;
        }
        truck.state = 'to_factory';
        truck.targetGx = homeGx;
        truck.targetGy = homeGy;
        continue;
      }

      const dx = truck.targetGx - truck.gx;
      const dy = truck.targetGy - truck.gy;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.14) {
        const step = Math.min(dist, speed * dtSec);
        const vx = (dx / dist) * step;
        const vy = (dy / dist) * step;
        truck.gx += vx;
        truck.gy += vy;
        truck.facing = vx - vy >= 0 ? 1 : -1;
        continue;
      }

      truck.gx = truck.targetGx;
      truck.gy = truck.targetGy;

      if (truck.state === 'to_forest') {
        if (Math.hypot(truck.gx - homeGx, truck.gy - homeGy) < 0.8) {
          const tree = this.findPermittedTreeNear(homeGx, homeGy, chunks, truck.id + state.tick);
          if (tree) {
            truck.targetGx = tree.gx;
            truck.targetGy = tree.gy;
            truck.harvestTimer = 1.1;
          } else {
            truck.harvestTimer = 1.5;
          }
          continue;
        }
        truck.state = 'chopping';
        truck.harvestTimer = 1.1;
        continue;
      }

      if (truck.state === 'to_factory') {
        if (truck.cargoTimber > 0) {
          const added = ResourceSystem.addClamped(state, 'wood', truck.cargoTimber);
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

        // Dispatch every 3rd truck trip to supply a connected sawmill
        if (sawmills.length > 0 && truck.id % 3 === 0) {
          const mill = sawmills[truck.id % sawmills.length];
          const mDef = BUILDINGS[mill.defId];
          const mFp = mDef ? getBuildingFootprint(mDef, mill.rotation ?? 0) : { width: 2, height: 2 };
          truck.state = 'delivering_sawmill';
          truck.targetGx = mill.gx + mFp.width * 0.5;
          truck.targetGy = mill.gy + mFp.height * 0.5;
          continue;
        }

        truck.cargoTimber = 0;
        const nextTree = this.findPermittedTreeNear(homeGx, homeGy, chunks, truck.id + state.tick);
        if (nextTree) {
          truck.state = 'to_forest';
          truck.targetGx = nextTree.gx;
          truck.targetGy = nextTree.gy;
        } else {
          truck.harvestTimer = 2.0;
        }
        continue;
      }

      if (truck.state === 'delivering_sawmill') {
        truck.cargoTimber = 0;
        // Boost sawmill cycle slightly on delivery
        if (sawmills.length > 0) {
          const mill = sawmills[truck.id % sawmills.length];
          if (mill.status === 'active') {
            mill.prodProgress = Math.min(0.98, mill.prodProgress + 0.12);
          }
        }
        truck.state = 'to_forest';
        const nextTree = this.findPermittedTreeNear(homeGx, homeGy, chunks, truck.id + state.tick);
        if (nextTree) {
          truck.targetGx = nextTree.gx;
          truck.targetGy = nextTree.gy;
        } else {
          truck.targetGx = homeGx;
          truck.targetGy = homeGy;
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

        // Avoid backtracking unless at a dead-end buffer
        const forward = neighbors.filter(([nx, ny]) => nx !== train.prevGx || ny !== train.prevGy);
        const pool = forward.length > 0 ? forward : neighbors;
        const pick = pool[(train.id + tx * 3 + ty * 7) % pool.length];
        train.prevGx = tx;
        train.prevGy = ty;
        train.progress = 0;
        // Store target in progress direction by setting gx/gy slightly? Let's store target in facing or step linearly:
        const dx = pick[0] - tx;
        const dy = pick[1] - ty;
        train.facing = dx - dy >= 0 ? 1 : -1;
        // Move immediately 0.01 towards target and interpolate cleanly
        train.gx = tx + dx * 0.01;
        train.gy = ty + dy * 0.01;
      } else {
        const targetGx = Math.round(train.gx + (train.gx - train.prevGx >= 0 ? 0.5 : -0.5));
        const targetGy = Math.round(train.gy + (train.gy - train.prevGy >= 0 ? 0.5 : -0.5));
        // Compute exact step vector from prev to current rounded tile:
        const dirX = Math.sign(train.gx - train.prevGx);
        const dirY = Math.sign(train.gy - train.prevGy);
        const destX = train.prevGx + dirX;
        const destY = train.prevGy + dirY;
        void targetGx;
        void targetGy;
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

  private syncRoadVehicles(state: WorldEngineState): void {
    if (this.cachedRoadTiles.length < 2) {
      this.roadVehicles.length = 0;
      return;
    }

    let busWanted = 0;
    let taxiWanted = 0;
    let tractorWanted = 0;
    let fishVanWanted = 0;

    for (const b of state.buildings) {
      if (b.status === 'constructing' || !b.enabled) continue;
      const def = BUILDINGS[b.defId];
      if (!def) continue;
      if (def.transitKind === 'bus') busWanted += 2;
      if (def.transitKind === 'taxi') taxiWanted += 2;
      if (def.subCategory === 'farming' || b.defId === 'farm_equipment_depot') tractorWanted += 1;
      if (def.subCategory === 'fishing' || b.defId === 'fish_market') fishVanWanted += 1;
    }

    const totalWanted = Math.min(24, busWanted + taxiWanted + tractorWanted + fishVanWanted);
    if (totalWanted === 0) {
      this.roadVehicles.length = 0;
      return;
    }

    const desiredKinds: Array<RoadVehicleAgent['kind']> = [];
    for (let i = 0; i < Math.min(8, busWanted); i++) desiredKinds.push('bus');
    for (let i = 0; i < Math.min(8, taxiWanted); i++) desiredKinds.push('taxi');
    for (let i = 0; i < Math.min(5, tractorWanted); i++) desiredKinds.push('tractor');
    for (let i = 0; i < Math.min(5, fishVanWanted); i++) desiredKinds.push('fish_van');
    desiredKinds.length = Math.min(desiredKinds.length, totalWanted);

    while (this.roadVehicles.length < desiredKinds.length) {
      const idx = this.roadVehicles.length;
      const start = this.cachedRoadTiles[(idx * 7) % this.cachedRoadTiles.length];
      this.roadVehicles.push({
        id: this.nextId++,
        kind: desiredKinds[idx],
        gx: start.gx,
        gy: start.gy,
        prevGx: start.gx,
        prevGy: start.gy,
        progress: 1,
        facing: 1,
      });
    }
    if (this.roadVehicles.length > desiredKinds.length) {
      this.roadVehicles.length = desiredKinds.length;
    }
    for (let i = 0; i < this.roadVehicles.length; i++) {
      this.roadVehicles[i].kind = desiredKinds[i];
    }
  }

  private stepRoadVehicles(dtSec: number): void {
    if (this.roadVehicles.length === 0 || this.roadSet.size === 0) return;

    for (const veh of this.roadVehicles) {
      const tx = Math.round(veh.gx);
      const ty = Math.round(veh.gy);
      if (!this.roadSet.has(`${tx}:${ty}`)) {
        if (this.cachedRoadTiles.length > 0) {
          const fallback = this.cachedRoadTiles[veh.id % this.cachedRoadTiles.length];
          veh.gx = fallback.gx;
          veh.gy = fallback.gy;
          veh.prevGx = fallback.gx;
          veh.prevGy = fallback.gy;
          veh.progress = 1;
        }
        continue;
      }

      if (veh.progress >= 1) {
        const neighbors: Array<[number, number]> = [];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = tx + dx;
          const ny = ty + dy;
          if (this.roadSet.has(`${nx}:${ny}`)) neighbors.push([nx, ny]);
        }
        if (neighbors.length === 0) continue;
        const forward = neighbors.filter(([nx, ny]) => nx !== veh.prevGx || ny !== veh.prevGy);
        const pool = forward.length > 0 ? forward : neighbors;
        const pick = pool[(veh.id * 11 + tx * 5 + ty * 3) % pool.length];
        veh.prevGx = tx;
        veh.prevGy = ty;
        veh.progress = 0;
        const dx = pick[0] - tx;
        const dy = pick[1] - ty;
        veh.facing = dx - dy >= 0 ? 1 : -1;
        veh.gx = tx + dx * 0.01;
        veh.gy = ty + dy * 0.01;
      } else {
        const dirX = Math.sign(veh.gx - veh.prevGx);
        const dirY = Math.sign(veh.gy - veh.prevGy);
        const destX = veh.prevGx + dirX;
        const destY = veh.prevGy + dirY;
        const speed = veh.kind === 'tractor' ? 1.65 : veh.kind === 'taxi' ? 2.8 : 2.25;
        veh.progress = Math.min(1, veh.progress + speed * dtSec);
        veh.gx = veh.prevGx + dirX * veh.progress;
        veh.gy = veh.prevGy + dirY * veh.progress;
        if (veh.progress >= 1) {
          veh.gx = destX;
          veh.gy = destY;
        }
      }
    }
  }
}
