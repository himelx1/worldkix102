import { BUILDINGS, getBuildingFootprint } from '../data/buildings.data';
import { getRoadProperties, isRoadAllowedForVehicle, ROADS, RoadType } from '../data/roads.data';
import type { ChunkManager } from '../core/ChunkManager';
import { BiomeId, BuildingInstance, RoadDirection, TileFlag, VehicleClass } from '../core/GameState';
import { RoadNetworkSystem } from './RoadNetworkSystem';

export type TransportMode = 'citizen' | 'vehicle' | 'train';

export interface GridPoint {
  gx: number;
  gy: number;
}

export interface FindPathOptions {
  vehicleClass?: VehicleClass;
  congestionMap?: ReadonlyMap<string, number>;
}

const DIRS: ReadonlyArray<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Strict network-aware movement rules & bounded A* pathfinding:
 * - Citizens walk ONLY on roads, bridges, and unlocked non-mountain dry land.
 *   They NEVER walk on unbridged water, buildings, mountains, or locked tiles.
 * - Vehicles travel strictly on roads & bridges, obey one-way directions,
 *   avoid congested bottlenecks, and route heavy trucks away from narrow residential lanes when possible.
 * - Trains travel strictly on RoadType.Rail tiles.
 */
export class PathfindingSystem {
  public static isTilePassable(
    gx: number,
    gy: number,
    chunks: ChunkManager,
    mode: TransportMode = 'citizen'
  ): boolean {
    const { chunk, index } = chunks.getTile(gx, gy);
    const unlocked = (chunk.flags[index] & TileFlag.Unlocked) !== 0;
    const road = chunk.roadType[index] as RoadType;
    if (chunk.buildingRef[index] !== -1 && road !== RoadType.Connector) return false;

    const biome = chunk.biomeId[index] as BiomeId;
    const isWater = chunks.isWaterBiome(biome);

    if (mode === 'train') {
      return unlocked && road === RoadType.Rail;
    }

    if (mode === 'vehicle') {
      // Vehicles strictly stay on drivable roads; locked-area roads are reachable ONLY across a Connector edge
      return road !== RoadType.None && road !== RoadType.Rail;
    }

    if (!unlocked) return false;

    // Citizen mode:
    if (isWater) {
      return road === RoadType.Bridge || road === RoadType.ElevatedHighway || road === RoadType.UndergroundRoad;
    }
    if (biome === BiomeId.Mountain) {
      return road !== RoadType.None;
    }
    return true;
  }

  /**
   * Validates directed edge traversal from (fromGx, fromGy) to (toGx, toGy).
   * Enforces Connector bridging across owned/locked borders and one-way road directions.
   */
  public static isEdgeTraversable(
    fromGx: number,
    fromGy: number,
    toGx: number,
    toGy: number,
    chunks: ChunkManager,
    mode: TransportMode = 'citizen'
  ): boolean {
    if (!this.isTilePassable(toGx, toGy, chunks, mode)) return false;
    if (mode !== 'vehicle') return true;

    const fromTile = chunks.getTile(fromGx, fromGy);
    const toTile = chunks.getTile(toGx, toGy);
    const fromUnlocked = (fromTile.chunk.flags[fromTile.index] & TileFlag.Unlocked) !== 0;
    const toUnlocked = (toTile.chunk.flags[toTile.index] & TileFlag.Unlocked) !== 0;
    if (fromUnlocked !== toUnlocked) {
      const fromRoad = fromTile.chunk.roadType[fromTile.index] as RoadType;
      const toRoad = toTile.chunk.roadType[toTile.index] as RoadType;
      if (fromRoad !== RoadType.Connector && toRoad !== RoadType.Connector) {
        return false;
      }
    }

    const dx = toGx - fromGx;
    const dy = toGy - fromGy;

    const fromDir = chunks.getRoadDirection(fromGx, fromGy);
    if (fromDir !== RoadDirection.TwoWay) {
      const vec = RoadNetworkSystem.getDirectionVector(fromDir);
      if (vec && dx === -vec.dx && dy === -vec.dy) {
        return false;
      }
    }

    const toDir = chunks.getRoadDirection(toGx, toGy);
    if (toDir !== RoadDirection.TwoWay) {
      const vec = RoadNetworkSystem.getDirectionVector(toDir);
      if (vec && dx === -vec.dx && dy === -vec.dy) {
        return false;
      }
    }

    return true;
  }

  /**
   * Layer-1 traversal rule used by route planning: a heavy vehicle may not enter
   * a road that is structurally too narrow for it (unless it is the only way out
   * of a dead end, which the A* relaxes via `allowUnsuitable`).
   */
  public static isTileSuitableForVehicle(
    gx: number,
    gy: number,
    chunks: ChunkManager,
    vehicleClass: VehicleClass
  ): boolean {
    const { chunk, index } = chunks.getTile(gx, gy);
    const road = chunk.roadType[index] as RoadType;
    if (road === RoadType.None || road === RoadType.Rail) return false;
    return isRoadAllowedForVehicle(road, vehicleClass);
  }

  public static getTileStepCost(
    gx: number,
    gy: number,
    chunks: ChunkManager,
    mode: TransportMode,
    opts?: FindPathOptions
  ): number {
    const { chunk, index } = chunks.getTile(gx, gy);
    const road = chunk.roadType[index] as RoadType;
    if (road === RoadType.None) {
      return mode === 'citizen' ? 1.75 : 999;
    }

    const spd = ROADS[road]?.speedMultiplier ?? 1.15;
    let cost = Math.max(0.28, 1.0 / spd);

    if (mode === 'vehicle') {
      const vClass = opts?.vehicleClass ?? 'car';
      const props = getRoadProperties(road);

      if (vClass === 'heavy_truck') {
        if (road === RoadType.Dirt) cost *= 2.8;
        else if (road === RoadType.SmallRoad) cost *= 2.4;
        else if (road === RoadType.ResidentialRoad) cost *= 2.5;
        else if (
          road === RoadType.IndustrialRoad ||
          road === RoadType.Highway ||
          road === RoadType.Expressway ||
          road === RoadType.Interchange
        ) {
          cost *= 0.72;
        } else if (!props.heavyTruckFriendly) {
          cost *= 1.45;
        }
      } else if (vClass === 'bus') {
        if (road === RoadType.Dirt || road === RoadType.SmallRoad) cost *= 1.8;
        else if (props.widthClass === 'wide' || road === RoadType.TwoLane || road === RoadType.CommercialBlvd) {
          cost *= 0.85;
        }
      } else if (vClass === 'car') {
        if (road === RoadType.IndustrialRoad) cost *= 1.25;
        else if (road === RoadType.ResidentialRoad || road === RoadType.TwoLane || road === RoadType.CommercialBlvd) {
          cost *= 0.9;
        }
      } else if (vClass === 'emergency') {
        if (props.widthClass === 'highway' || props.widthClass === 'wide') cost *= 0.75;
      }

      // Structural suitability: heavy vehicles strongly prefer roads built for
      // them. A class that is *not permitted* at all gets a near-prohibitive cost
      // so a route only uses it when there is literally no alternative; the
      // traffic step then treats it as a reroute (never a silent shortcut).
      if (!isRoadAllowedForVehicle(road, vClass)) {
        cost *= vClass === 'heavy_truck' ? 9.0 : 4.0;
      }

      const cong = opts?.congestionMap?.get(`${gx}:${gy}`) ?? 0;
      if (cong > 0.05) {
        cost += cong * (vClass === 'emergency' ? 0.55 : 1.75);
      }
    }

    return cost;
  }

  /**
   * Returns all valid entrance tiles adjacent to a building footprint,
   * sorted with paved/wide road access tiles first.
   */
  public static findBuildingEntrances(
    b: BuildingInstance,
    chunks: ChunkManager,
    mode: TransportMode = 'citizen'
  ): GridPoint[] {
    const def = BUILDINGS[b.defId];
    if (!def) return [];
    const fp = getBuildingFootprint(def, b.rotation ?? 0);

    const roadEntrances: Array<{ gx: number; gy: number; score: number }> = [];
    const landEntrances: GridPoint[] = [];

    for (let dx = -1; dx <= fp.width; dx++) {
      for (let dy = -1; dy <= fp.height; dy++) {
        const isPerimeter =
          ((dx === -1 || dx === fp.width) && dy >= 0 && dy < fp.height) ||
          ((dy === -1 || dy === fp.height) && dx >= 0 && dx < fp.width);
        if (!isPerimeter) continue;

        const tx = b.gx + dx;
        const ty = b.gy + dy;
        if (!this.isTilePassable(tx, ty, chunks, mode)) continue;

        const { chunk, index } = chunks.getTile(tx, ty);
        const rt = chunk.roadType[index] as RoadType;
        if (rt !== RoadType.None) {
          const tier = ROADS[rt]?.tierRank ?? rt;
          roadEntrances.push({ gx: tx, gy: ty, score: tier });
        } else if (mode === 'citizen') {
          landEntrances.push({ gx: tx, gy: ty });
        }
      }
    }

    roadEntrances.sort((a, c) => c.score - a.score);
    const out: GridPoint[] = roadEntrances.map((e) => ({ gx: e.gx, gy: e.gy }));
    for (const l of landEntrances) out.push(l);
    return out;
  }

  /**
   * Returns the best accessible entrance tile adjacent to a building footprint
   * (preferring highest-tier connected roads/bridges first, then dry empty land).
   */
  public static findBuildingEntrance(
    b: BuildingInstance,
    chunks: ChunkManager,
    mode: TransportMode = 'citizen'
  ): GridPoint | null {
    const list = this.findBuildingEntrances(b, chunks, mode);
    return list.length > 0 ? list[0] : null;
  }

  /**
   * Finds the closest drivable road tile to a world coordinate within maxRadius.
   */
  public static findNearestRoadTile(
    gx: number,
    gy: number,
    chunks: ChunkManager,
    maxRadius = 6
  ): GridPoint | null {
    const cx = Math.round(gx);
    const cy = Math.round(gy);
    let best: { gx: number; gy: number; dist: number } | null = null;
    for (let dy = -maxRadius; dy <= maxRadius; dy++) {
      for (let dx = -maxRadius; dx <= maxRadius; dx++) {
        const tx = cx + dx;
        const ty = cy + dy;
        if (!this.isTilePassable(tx, ty, chunks, 'vehicle')) continue;
        const d = Math.hypot(dx, dy);
        if (!best || d < best.dist) {
          best = { gx: tx, gy: ty, dist: d };
        }
      }
    }
    return best ? { gx: best.gx, gy: best.gy } : null;
  }

  /**
   * Bounded A* pathfinder returning tile waypoints (excluding start, including goal)
   * using a binary min-heap for O(log N) open-set operations.
   */
  public static findPath(
    startGx: number,
    startGy: number,
    goalGx: number,
    goalGy: number,
    chunks: ChunkManager,
    mode: TransportMode = 'citizen',
    maxNodes = 420,
    opts?: FindPathOptions
  ): GridPoint[] | null {
    const sx = Math.round(startGx);
    const sy = Math.round(startGy);
    const gx = Math.round(goalGx);
    const gy = Math.round(goalGy);

    if (sx === gx && sy === gy) return [{ gx, gy }];
    if (!this.isTilePassable(gx, gy, chunks, mode)) return null;

    const startKey = `${sx}:${sy}`;
    const goalKey = `${gx}:${gy}`;

    interface HeapNode {
      x: number;
      y: number;
      key: string;
      f: number;
      pdx: number;
      pdy: number;
    }

    const heap: HeapNode[] = [
      { x: sx, y: sy, key: startKey, f: Math.abs(gx - sx) + Math.abs(gy - sy), pdx: 0, pdy: 0 },
    ];
    const heapIndex = new Map<string, number>([[startKey, 0]]);
    const gScore = new Map<string, number>([[startKey, 0]]);
    const cameFrom = new Map<string, GridPoint>();
    const closed = new Set<string>();

    const swap = (i: number, j: number) => {
      const a = heap[i];
      const b = heap[j];
      heap[i] = b;
      heap[j] = a;
      heapIndex.set(b.key, i);
      heapIndex.set(a.key, j);
    };

    const siftUp = (i: number) => {
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[i].f >= heap[p].f) break;
        swap(i, p);
        i = p;
      }
    };

    const siftDown = (i: number) => {
      const n = heap.length;
      while (true) {
        let best = i;
        const l = i * 2 + 1;
        const r = l + 1;
        if (l < n && heap[l].f < heap[best].f) best = l;
        if (r < n && heap[r].f < heap[best].f) best = r;
        if (best === i) break;
        swap(i, best);
        i = best;
      }
    };

    const popMin = (): HeapNode => {
      const top = heap[0];
      heapIndex.delete(top.key);
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        heapIndex.set(last.key, 0);
        siftDown(0);
      }
      return top;
    };

    let expanded = 0;
    while (heap.length > 0 && expanded < maxNodes) {
      const cur = popMin();
      if (cur.key === goalKey) {
        const path: GridPoint[] = [];
        let trace: GridPoint | undefined = { gx, gy };
        while (trace && !(trace.gx === sx && trace.gy === sy)) {
          path.push(trace);
          trace = cameFrom.get(`${trace.gx}:${trace.gy}`);
        }
        path.reverse();
        return path;
      }

      closed.add(cur.key);
      expanded++;
      const curG = gScore.get(cur.key) ?? Infinity;

      for (const [dx, dy] of DIRS) {
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        const nKey = `${nx}:${ny}`;
        if (closed.has(nKey)) continue;
        if (!this.isEdgeTraversable(cur.x, cur.y, nx, ny, chunks, mode)) continue;

        let stepCost = this.getTileStepCost(nx, ny, chunks, mode, opts);
        if (mode === 'vehicle' && (cur.pdx !== 0 || cur.pdy !== 0) && (dx !== cur.pdx || dy !== cur.pdy)) {
          stepCost += 0.14; // Prefer straight arterial corridors over unnecessary zig-zags
        }

        const tentativeG = curG + stepCost;
        if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
          cameFrom.set(nKey, { gx: cur.x, gy: cur.y });
          gScore.set(nKey, tentativeG);
          const f = tentativeG + (Math.abs(gx - nx) + Math.abs(gy - ny)) * 0.55;
          const existingIdx = heapIndex.get(nKey);
          if (existingIdx !== undefined) {
            heap[existingIdx].f = f;
            heap[existingIdx].pdx = dx;
            heap[existingIdx].pdy = dy;
            siftUp(existingIdx);
          } else {
            const idx = heap.length;
            heap.push({ x: nx, y: ny, key: nKey, f, pdx: dx, pdy: dy });
            heapIndex.set(nKey, idx);
            siftUp(idx);
          }
        }
      }
    }

    return null;
  }
}
