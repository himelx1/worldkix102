import { BUILDINGS, getBuildingFootprint } from '../data/buildings.data';
import { ROADS, RoadType } from '../data/roads.data';
import type { ChunkManager } from '../core/ChunkManager';
import type { BuildingInstance, WorldEngineState } from '../core/GameState';
import { CHUNK_SIZE } from '../core/IsoMath';

export class RoadNetworkSystem {
  private roadClusterMap = new Map<string, number>();
  private clusterCongestionMap = new Map<number, number>();
  private buildingRoadTierMap = new Map<number, number>();
  private roadDirty = true;

  public markDirty(): void {
    this.roadDirty = true;
  }

  public getRoadBitmask(gx: number, gy: number, chunks: ChunkManager): number {
    const { chunk, index } = chunks.getTile(gx, gy);
    const rt = chunk.roadType[index] as RoadType;
    if (rt === RoadType.None) return 0;

    const isRail = rt === RoadType.Rail;
    let mask = 0;
    const neighbors: Array<[number, number, number]> = [
      [0, -1, 1], // N
      [1, 0, 2],  // E
      [0, 1, 4],  // S
      [-1, 0, 8], // W
    ];

    for (const [dx, dy, bit] of neighbors) {
      const nb = chunks.getTile(gx + dx, gy + dy);
      const nrt = nb.chunk.roadType[nb.index] as RoadType;
      if (nrt === RoadType.None) continue;
      if (isRail ? nrt === RoadType.Rail : nrt !== RoadType.Rail) {
        mask |= bit;
      }
    }
    return mask;
  }

  public recomputeIfDirty(chunks: ChunkManager, state: WorldEngineState): void {
    if (!this.roadDirty) return;
    this.roadDirty = false;
    this.roadClusterMap.clear();
    this.clusterCongestionMap.clear();
    this.buildingRoadTierMap.clear();

    const roadTiles: Array<{ gx: number; gy: number; type: RoadType }> = [];
    for (const chunk of chunks.getAllLoadedChunks()) {
      if (!chunk.isModified) continue;
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const idx = ly * CHUNK_SIZE + lx;
          const rt = chunk.roadType[idx] as RoadType;
          if (rt !== RoadType.None) {
            roadTiles.push({
              gx: chunk.cx * CHUNK_SIZE + lx,
              gy: chunk.cy * CHUNK_SIZE + ly,
              type: rt,
            });
          }
        }
      }
    }

    state.roadConnectedCount = roadTiles.length;
    const tileSet = new Map<string, RoadType>();
    for (const t of roadTiles) {
      tileSet.set(`${t.gx}:${t.gy}`, t.type);
    }

    let nextCluster = 1;
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    const clusterStats = new Map<number, { count: number; speedSum: number; buildings: number }>();

    for (const start of roadTiles) {
      const startKey = `${start.gx}:${start.gy}`;
      if (this.roadClusterMap.has(startKey)) continue;
      const clusterId = nextCluster++;
      const queue: Array<[number, number]> = [[start.gx, start.gy]];
      this.roadClusterMap.set(startKey, clusterId);
      const stat = { count: 0, speedSum: 0, buildings: 0 };

      while (queue.length > 0) {
        const [x, y] = queue.pop()!;
        const rType = tileSet.get(`${x}:${y}`) ?? RoadType.Dirt;
        stat.count++;
        stat.speedSum += ROADS[rType]?.speedMultiplier ?? 1.0;

        for (const [dx, dy] of dirs) {
          const nk = `${x + dx}:${y + dy}`;
          const nType = tileSet.get(nk);
          if (nType !== undefined && !this.roadClusterMap.has(nk)) {
            const sameClass = rType === RoadType.Rail ? nType === RoadType.Rail : nType !== RoadType.Rail;
            if (sameClass) {
              this.roadClusterMap.set(nk, clusterId);
              queue.push([x + dx, y + dy]);
            }
          }
        }
      }
      clusterStats.set(clusterId, stat);
    }

    // Update each building's adjacent road connectivity & count buildings per road cluster
    for (const b of state.buildings) {
      const { connectedCluster } = this.evaluateBuildingRoadAccess(b, chunks);
      if (connectedCluster > 0) {
        const stat = clusterStats.get(connectedCluster);
        if (stat) stat.buildings += 1;
      }
    }

    for (const [clusterId, stat] of clusterStats.entries()) {
      const avgSpeed = stat.count > 0 ? stat.speedSum / stat.count : 1.0;
      const density = stat.buildings / Math.max(1, stat.count);
      const threshold = 0.7 * avgSpeed;
      let congestion = 1.0;
      if (density > threshold) {
        congestion = Math.max(0.65, 1.0 - (density - threshold) * 0.25);
      }
      this.clusterCongestionMap.set(clusterId, Number(congestion.toFixed(2)));
    }

    for (const b of state.buildings) {
      b.congestionFactor =
        b.connectedRoadCluster > 0 ? (this.clusterCongestionMap.get(b.connectedRoadCluster) ?? 1.0) : 1.0;
    }
  }

  public evaluateBuildingRoadAccess(b: BuildingInstance, chunks: ChunkManager): {
    connectedCluster: number;
    bestRoadTier: number;
  } {
    const def = BUILDINGS[b.defId];
    if (!def) return { connectedCluster: 0, bestRoadTier: 0 };

    const fp = getBuildingFootprint(def, b.rotation ?? 0);
    let bestCluster = 0;
    let bestTier = 0;

    for (let dx = -1; dx <= fp.width; dx++) {
      for (let dy = -1; dy <= fp.height; dy++) {
        const isEdge =
          ((dx === -1 || dx === fp.width) && dy >= 0 && dy < fp.height) ||
          ((dy === -1 || dy === fp.height) && dx >= 0 && dx < fp.width);
        if (!isEdge) continue;

        const nx = b.gx + dx;
        const ny = b.gy + dy;
        const { chunk, index } = chunks.getTile(nx, ny);
        const rt = chunk.roadType[index] as RoadType;
        if (rt !== RoadType.None) {
          const cluster = this.roadClusterMap.get(`${nx}:${ny}`) ?? 1;
          if (cluster > 0) bestCluster = cluster;
          const roadDef = ROADS[rt];
          const tier = rt === RoadType.Bridge ? 2 : rt === RoadType.Rail ? 9 : (roadDef?.tierRank ?? rt);
          if (tier > bestTier) bestTier = tier;
        }
      }
    }

    b.connectedRoadCluster = bestCluster;
    b.congestionFactor = bestCluster > 0 ? (this.clusterCongestionMap.get(bestCluster) ?? 1.0) : 1.0;
    this.buildingRoadTierMap.set(b.id, bestTier);
    return { connectedCluster: bestCluster, bestRoadTier: bestTier };
  }

  public getCachedRoadAccess(b: BuildingInstance, chunks: ChunkManager): {
    connectedCluster: number;
    bestRoadTier: number;
  } {
    const cachedTier = this.buildingRoadTierMap.get(b.id);
    if (cachedTier !== undefined && !this.roadDirty) {
      return { connectedCluster: b.connectedRoadCluster, bestRoadTier: cachedTier };
    }
    return this.evaluateBuildingRoadAccess(b, chunks);
  }

  public getClusterCongestionFactor(b: BuildingInstance, state: WorldEngineState, _chunks: ChunkManager): number {
    if (b.connectedRoadCluster <= 0) return 1.0;
    let base = this.clusterCongestionMap.get(b.connectedRoadCluster) ?? 1.0;
    if (base < 1.0) {
      const hasHubMitigation = state.buildings.some(
        (other) =>
          other.status === 'active' &&
          (other.defId === 'cart_depot' || other.defId === 'train_station' || other.defId === 'warehouse')
      );
      if (hasHubMitigation) {
        base = Math.min(1.0, base + 0.12);
      }
    }
    b.congestionFactor = Number(base.toFixed(2));
    return b.congestionFactor;
  }

  public getBuildingLogisticsMultiplier(b: BuildingInstance, state: WorldEngineState, chunks: ChunkManager): number {
    const { bestRoadTier } = this.getCachedRoadAccess(b, chunks);
    let base = 1.0;
    if (bestRoadTier > 0) {
      const roadDef = ROADS[bestRoadTier as RoadType];
      if (roadDef) {
        base = 0.95 + (roadDef.speedMultiplier - 1.0) * 0.25;
      }
    }

    // Add global logistics bonuses from Cart Depots, Harbors, Train Stations, Airports
    let hubBoost = 0;
    for (const other of state.buildings) {
      if (other.status !== 'active') continue;
      const odef = BUILDINGS[other.defId];
      if (odef?.logisticsBoost) {
        hubBoost += odef.logisticsBoost * (1 + (other.level - 1) * 0.2);
      }
    }

    const congestion = this.getClusterCongestionFactor(b, state, chunks);
    return Math.min(1.85, (base + Math.min(0.65, hubBoost)) * congestion);
  }
}
