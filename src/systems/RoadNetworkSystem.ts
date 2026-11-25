import { BUILDINGS, getBuildingFootprint } from '../data/buildings.data';
import { getRoadProperties, ROADS, RoadType } from '../data/roads.data';
import type { ChunkManager } from '../core/ChunkManager';
import { BuildingInstance, RoadDirection, WorldEngineState } from '../core/GameState';
import { CHUNK_SIZE } from '../core/IsoMath';

export type IntersectionKind =
  | 'none'
  | 'isolated'
  | 'dead_end'
  | 'straight'
  | 'curve'
  | 't_junction'
  | 'cross'
  | 'roundabout'
  | 'interchange';

export type SignalState = 'green' | 'yellow' | 'red' | 'yield' | 'none';

export interface RoadClusterInfo {
  id: number;
  roadClass: 'road' | 'rail';
  count: number;
  speedSum: number;
  avgSpeed: number;
  buildings: number;
  isMainNetwork: boolean;
  isDisconnected: boolean;
  congestionFactor: number;
}

export interface BuildingRoadAccessPoint {
  gx: number;
  gy: number;
  roadType: RoadType;
  clusterId: number;
  tierRank: number;
}

export interface BuildingRoadAccessInfo {
  connectedCluster: number;
  bestRoadTier: number;
  heavyTruckSuitable: boolean;
  accessPoints: BuildingRoadAccessPoint[];
}

export interface RoadNetworkSummary {
  totalRoadTiles: number;
  totalRailTiles: number;
  networkCount: number;
  mainNetworkId: number;
  mainNetworkSize: number;
  disconnectedSegments: number;
  disconnectedClusters: number;
  congestedTiles: number;
  activeVehicles: number;
  avgCongestionPct: number;
}

export class RoadNetworkSystem {
  public networkVersion = 1;

  private roadClusterMap = new Map<string, number>();
  private clusterStatsMap = new Map<number, RoadClusterInfo>();
  private clusterCongestionMap = new Map<number, number>();
  private tileCongestionMap = new Map<string, number>();
  private buildingAccessMap = new Map<number, BuildingRoadAccessInfo>();
  private totalRoadTiles = 0;
  private totalRailTiles = 0;
  private mainNetworkId = 0;
  private mainNetworkSize = 0;
  private roadDirty = true;

  public markDirty(): void {
    this.roadDirty = true;
    this.networkVersion += 1;
  }

  public static getDirectionVector(dir: RoadDirection): { dx: number; dy: number } | null {
    switch (dir) {
      case RoadDirection.OneWayN:
        return { dx: 0, dy: -1 };
      case RoadDirection.OneWayE:
        return { dx: 1, dy: 0 };
      case RoadDirection.OneWayS:
        return { dx: 0, dy: 1 };
      case RoadDirection.OneWayW:
        return { dx: -1, dy: 0 };
      default:
        return null;
    }
  }

  public getRoadBitmask(gx: number, gy: number, chunks: ChunkManager): number {
    const { chunk, index } = chunks.getTile(gx, gy);
    const rt = chunk.roadType[index] as RoadType;
    if (rt === RoadType.None) return 0;

    const isRail = rt === RoadType.Rail;
    const curUnlocked = chunks.isUnlocked(gx, gy);
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
      const sameClass = isRail ? nrt === RoadType.Rail : nrt !== RoadType.Rail;
      if (!sameClass) continue;
      if (!isRail) {
        const nbUnlocked = chunks.isUnlocked(gx + dx, gy + dy);
        if (curUnlocked !== nbUnlocked && rt !== RoadType.Connector && nrt !== RoadType.Connector) {
          continue;
        }
      }
      mask |= bit;
    }
    return mask;
  }

  public evaluateConnectorStatus(
    gx: number,
    gy: number,
    chunks: ChunkManager
  ): {
    connected: boolean;
    statusText: string;
    touchesOwnedRoad: boolean;
    touchesLockedRoad: boolean;
    clusterId: number;
  } {
    let touchesOwnedRoad = false;
    let touchesLockedRoad = false;
    let touchesLockedLand = false;
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ]) {
      const nx = gx + dx;
      const ny = gy + dy;
      const unlocked = chunks.isUnlocked(nx, ny);
      if (!unlocked) touchesLockedLand = true;
      const nb = chunks.getTile(nx, ny);
      const nrt = nb.chunk.roadType[nb.index] as RoadType;
      if (nrt === RoadType.None || nrt === RoadType.Rail) continue;
      if (unlocked) touchesOwnedRoad = true;
      else touchesLockedRoad = true;
    }

    const connected = touchesOwnedRoad && (touchesLockedRoad || touchesLockedLand);
    const statusText = !touchesLockedLand
      ? 'Not on border: Place on final owned border tiles touching locked land'
      : !touchesOwnedRoad
        ? 'Waiting for road: Connect an owned road to this Connector'
        : touchesLockedRoad
          ? 'Connected: Bridging Owned Road ↔ Locked-Area Road'
          : 'Border Gate Active: Owned road connected to locked frontier';

    return {
      connected,
      statusText,
      touchesOwnedRoad,
      touchesLockedRoad,
      clusterId: this.getRoadClusterId(gx, gy),
    };
  }

  public evaluateConnectorBuildingStatus(
    b: BuildingInstance,
    chunks: ChunkManager
  ): {
    connected: boolean;
    statusText: string;
    touchesOwnedRoad: boolean;
    touchesLockedRoad: boolean;
    touchesLockedLand: boolean;
    clusterId: number;
  } {
    const def = BUILDINGS[b.defId];
    const fp = def ? getBuildingFootprint(def, b.rotation ?? 0) : { width: 1, height: 3 };
    let touchesOwnedRoad = false;
    let touchesLockedRoad = false;
    let touchesLockedLand = false;

    for (let dx = -1; dx <= fp.width; dx++) {
      for (let dy = -1; dy <= fp.height; dy++) {
        const isEdge =
          ((dx === -1 || dx === fp.width) && dy >= 0 && dy < fp.height) ||
          ((dy === -1 || dy === fp.height) && dx >= 0 && dx < fp.width);
        if (!isEdge) continue;
        const nx = b.gx + dx;
        const ny = b.gy + dy;
        const unlocked = chunks.isUnlocked(nx, ny);
        if (!unlocked) touchesLockedLand = true;
        const nb = chunks.getTile(nx, ny);
        const nrt = nb.chunk.roadType[nb.index] as RoadType;
        if (nrt === RoadType.None || nrt === RoadType.Rail) continue;
        if (unlocked) touchesOwnedRoad = true;
        else touchesLockedRoad = true;
      }
    }

    const connected = touchesOwnedRoad && touchesLockedLand;
    const statusText = !touchesLockedLand
      ? 'Not on border: Move to the final owned border tiles touching locked land'
      : !touchesOwnedRoad
        ? 'Waiting for road: Connect any owned road to this 1×3 Connector'
        : touchesLockedRoad
          ? 'Connected: Owned Road ↔ Locked-Area Road Bridged'
          : 'Border Gate Active: Owned Road Connected (Trucks can cross to reach nearby locked land)';

    return {
      connected,
      statusText,
      touchesOwnedRoad,
      touchesLockedRoad,
      touchesLockedLand,
      clusterId: this.getRoadClusterId(b.gx, b.gy),
    };
  }

  public getIntersectionKind(gx: number, gy: number, chunks: ChunkManager): IntersectionKind {
    const { chunk, index } = chunks.getTile(gx, gy);
    const rt = chunk.roadType[index] as RoadType;
    if (rt === RoadType.None) return 'none';
    if (rt === RoadType.Roundabout) return 'roundabout';
    if (rt === RoadType.Interchange) return 'interchange';

    const mask = this.getRoadBitmask(gx, gy, chunks);
    const bits = ((mask & 1) ? 1 : 0) + ((mask & 2) ? 1 : 0) + ((mask & 4) ? 1 : 0) + ((mask & 8) ? 1 : 0);
    if (bits === 0) return 'isolated';
    if (bits === 1) return 'dead_end';
    if (bits === 2) {
      if (mask === 5 || mask === 10) return 'straight';
      return 'curve';
    }
    if (bits === 3) return 't_junction';
    return 'cross';
  }

  public hasTrafficSignal(gx: number, gy: number, chunks: ChunkManager): boolean {
    const { chunk, index } = chunks.getTile(gx, gy);
    const rt = chunk.roadType[index] as RoadType;
    if (rt === RoadType.None || rt === RoadType.Rail) return false;
    const props = getRoadProperties(rt);
    if (!props.supportsSignals) return false;
    const kind = this.getIntersectionKind(gx, gy, chunks);
    return kind === 't_junction' || kind === 'cross';
  }

  /**
   * Evaluates deterministic N-S vs E-W traffic light phase at a signalized intersection.
   * Cycle is 16s: 0..6.4s N-S green, 6.4..8.0s N-S yellow/clearance, 8.0..14.4s E-W green, 14.4..16.0s E-W clearance.
   */
  public getSignalState(
    gx: number,
    gy: number,
    fromDx: number,
    fromDy: number,
    simTimeSec: number,
    chunks?: ChunkManager
  ): SignalState {
    if (chunks) {
      const { chunk, index } = chunks.getTile(gx, gy);
      const rt = chunk.roadType[index] as RoadType;
      if (rt === RoadType.Roundabout || rt === RoadType.Interchange) return 'yield';
      const kind = this.getIntersectionKind(gx, gy, chunks);
      if (kind !== 't_junction' && kind !== 'cross') return 'none';
      if (!getRoadProperties(rt).supportsSignals) return 'yield';
    }

    const offset = (((gx + gy) % 2) + 2) % 2;
    const phase = ((simTimeSec + offset * 4.0) % 16 + 16) % 16;
    const movingNS = Math.abs(fromDy) >= Math.abs(fromDx);

    if (movingNS) {
      if (phase < 6.4) return 'green';
      if (phase < 8.0) return 'yellow';
      return 'red';
    } else {
      if (phase >= 8.0 && phase < 14.4) return 'green';
      if (phase >= 14.4) return 'yellow';
      return 'red';
    }
  }

  public recomputeIfDirty(chunks: ChunkManager, state: WorldEngineState): void {
    if (!this.roadDirty) return;
    this.roadDirty = false;
    this.roadClusterMap.clear();
    this.clusterStatsMap.clear();
    this.clusterCongestionMap.clear();
    this.buildingAccessMap.clear();

    const roadTiles: Array<{ gx: number; gy: number; type: RoadType }> = [];
    let drivableCount = 0;
    let railCount = 0;

    for (const chunk of chunks.getAllLoadedChunks()) {
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
            if (rt === RoadType.Rail) railCount++;
            else drivableCount++;
          }
        }
      }
    }

    this.totalRoadTiles = drivableCount;
    this.totalRailTiles = railCount;
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
    const clusterRaw = new Map<
      number,
      { roadClass: 'road' | 'rail'; count: number; speedSum: number; buildings: number }
    >();

    for (const start of roadTiles) {
      const startKey = `${start.gx}:${start.gy}`;
      if (this.roadClusterMap.has(startKey)) continue;
      const clusterId = nextCluster++;
      const queue: Array<[number, number]> = [[start.gx, start.gy]];
      this.roadClusterMap.set(startKey, clusterId);
      const stat = {
        roadClass: (start.type === RoadType.Rail ? 'rail' : 'road') as 'road' | 'rail',
        count: 0,
        speedSum: 0,
        buildings: 0,
      };

      while (queue.length > 0) {
        const [x, y] = queue.pop()!;
        const rType = tileSet.get(`${x}:${y}`) ?? RoadType.Dirt;
        stat.count++;
        stat.speedSum += ROADS[rType]?.speedMultiplier ?? 1.0;

        const curUnlocked = chunks.isUnlocked(x, y);
        for (const [dx, dy] of dirs) {
          const nk = `${x + dx}:${y + dy}`;
          const nType = tileSet.get(nk);
          if (nType !== undefined && !this.roadClusterMap.has(nk)) {
            const sameClass = rType === RoadType.Rail ? nType === RoadType.Rail : nType !== RoadType.Rail;
            if (!sameClass) continue;
            if (rType !== RoadType.Rail) {
              const nbUnlocked = chunks.isUnlocked(x + dx, y + dy);
              if (curUnlocked !== nbUnlocked && rType !== RoadType.Connector && nType !== RoadType.Connector) {
                continue;
              }
            }
            this.roadClusterMap.set(nk, clusterId);
            queue.push([x + dx, y + dy]);
          }
        }
      }
      clusterRaw.set(clusterId, stat);
    }

    // Determine main drivable road network (largest connected road component)
    let mainId = 0;
    let mainSize = 0;
    for (const [cid, stat] of clusterRaw.entries()) {
      if (stat.roadClass === 'road' && stat.count > mainSize) {
        mainSize = stat.count;
        mainId = cid;
      }
    }
    this.mainNetworkId = mainId;
    this.mainNetworkSize = mainSize;

    // Update each building's adjacent road connectivity & count buildings per road cluster
    for (const b of state.buildings) {
      const { connectedCluster } = this.evaluateBuildingRoadAccess(b, chunks);
      if (connectedCluster > 0) {
        const stat = clusterRaw.get(connectedCluster);
        if (stat) stat.buildings += 1;
      }
    }

    for (const [clusterId, stat] of clusterRaw.entries()) {
      const avgSpeed = stat.count > 0 ? stat.speedSum / stat.count : 1.0;
      const density = stat.buildings / Math.max(1, stat.count);
      const threshold = 0.7 * avgSpeed;
      let congestion = 1.0;
      if (density > threshold) {
        congestion = Math.max(0.65, 1.0 - (density - threshold) * 0.25);
      }
      const roundedCongestion = Number(congestion.toFixed(2));
      this.clusterCongestionMap.set(clusterId, roundedCongestion);

      const isMain = clusterId === mainId;
      const isDisconnected =
        stat.roadClass === 'road' &&
        (stat.count <= 1 || (mainId > 0 && clusterId !== mainId));

      this.clusterStatsMap.set(clusterId, {
        id: clusterId,
        roadClass: stat.roadClass,
        count: stat.count,
        speedSum: stat.speedSum,
        avgSpeed,
        buildings: stat.buildings,
        isMainNetwork: isMain,
        isDisconnected,
        congestionFactor: roundedCongestion,
      });
    }

    // Prune stale tile congestion entries where roads were deleted
    for (const key of this.tileCongestionMap.keys()) {
      if (!tileSet.has(key)) {
        this.tileCongestionMap.delete(key);
      }
    }

    for (const b of state.buildings) {
      b.congestionFactor =
        b.connectedRoadCluster > 0 ? (this.clusterCongestionMap.get(b.connectedRoadCluster) ?? 1.0) : 1.0;
    }
  }

  public recordTrafficSample(
    tileVehicleCount: Map<string, number>,
    tileWaitingCount: Map<string, number>,
    chunks: ChunkManager,
    state: WorldEngineState
  ): void {
    // Decay existing tile congestion and blend current active traffic + waiting queues
    const seen = new Set<string>();
    for (const [key, count] of tileVehicleCount.entries()) {
      seen.add(key);
      const wait = tileWaitingCount.get(key) ?? 0;
      const [gxStr, gyStr] = key.split(':');
      const gx = Number(gxStr);
      const gy = Number(gyStr);
      const { chunk, index } = chunks.getTile(gx, gy);
      const rt = chunk.roadType[index] as RoadType;
      const lanes = rt !== RoadType.None ? Math.max(1, getRoadProperties(rt).totalLanes) : 1;
      const capacity = Math.max(1.5, lanes * 0.9);
      const rawLoad = Math.min(1, (count + wait * 1.4 - 0.6) / capacity);
      const prev = this.tileCongestionMap.get(key) ?? 0;
      const next = Math.max(0, Math.min(1, prev * 0.72 + Math.max(0, rawLoad) * 0.28));
      if (next < 0.02) {
        this.tileCongestionMap.delete(key);
      } else {
        this.tileCongestionMap.set(key, Number(next.toFixed(3)));
      }
    }

    for (const [key, prev] of this.tileCongestionMap.entries()) {
      if (seen.has(key)) continue;
      const decayed = prev * 0.78;
      if (decayed < 0.02) {
        this.tileCongestionMap.delete(key);
      } else {
        this.tileCongestionMap.set(key, Number(decayed.toFixed(3)));
      }
    }

    // Reflect local access-tile congestion onto nearby buildings cleanly
    for (const b of state.buildings) {
      const access = this.buildingAccessMap.get(b.id);
      const baseClusterFactor =
        b.connectedRoadCluster > 0 ? (this.clusterCongestionMap.get(b.connectedRoadCluster) ?? 1.0) : 1.0;
      if (!access || access.accessPoints.length === 0) {
        b.congestionFactor = baseClusterFactor;
        continue;
      }
      let maxLocalLoad = 0;
      for (const ap of access.accessPoints) {
        const load = this.tileCongestionMap.get(`${ap.gx}:${ap.gy}`) ?? 0;
        if (load > maxLocalLoad) maxLocalLoad = load;
      }
      const trafficFactor = Math.max(0.55, 1.0 - maxLocalLoad * 0.35);
      b.congestionFactor = Number(Math.min(baseClusterFactor, trafficFactor).toFixed(2));
    }
  }

  public getTileCongestion(gx: number, gy: number): number {
    return this.tileCongestionMap.get(`${gx}:${gy}`) ?? 0;
  }

  public getTileCongestionMap(): ReadonlyMap<string, number> {
    return this.tileCongestionMap;
  }

  public getRoadClusterId(gx: number, gy: number): number {
    return this.roadClusterMap.get(`${gx}:${gy}`) ?? 0;
  }

  public getClusterInfo(clusterId: number): RoadClusterInfo | undefined {
    return this.clusterStatsMap.get(clusterId);
  }

  public getAllClusterStats(): ReadonlyMap<number, RoadClusterInfo> {
    return this.clusterStatsMap;
  }

  public isRoadDisconnected(gx: number, gy: number): boolean {
    const cid = this.roadClusterMap.get(`${gx}:${gy}`);
    if (!cid) return false;
    return this.clusterStatsMap.get(cid)?.isDisconnected ?? false;
  }

  public evaluateBuildingRoadAccess(b: BuildingInstance, chunks: ChunkManager): BuildingRoadAccessInfo {
    const def = BUILDINGS[b.defId];
    if (!def) {
      return { connectedCluster: 0, bestRoadTier: 0, heavyTruckSuitable: false, accessPoints: [] };
    }

    const fp = getBuildingFootprint(def, b.rotation ?? 0);
    let bestCluster = 0;
    let bestClusterSize = -1;
    let bestTier = 0;
    let heavyTruckSuitable = false;
    const accessPoints: BuildingRoadAccessPoint[] = [];

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
          const clusterSize = this.clusterStatsMap.get(cluster)?.count ?? 1;
          const roadDef = ROADS[rt];
          const tier = rt === RoadType.Bridge ? 2 : rt === RoadType.Rail ? 9 : (roadDef?.tierRank ?? rt);
          if (rt !== RoadType.Rail) {
            if (clusterSize > bestClusterSize) {
              bestClusterSize = clusterSize;
              bestCluster = cluster;
            }
            if (getRoadProperties(rt).heavyTruckFriendly) {
              heavyTruckSuitable = true;
            }
          } else if (bestCluster === 0) {
            bestCluster = cluster;
          }
          if (tier > bestTier) bestTier = tier;
          accessPoints.push({ gx: nx, gy: ny, roadType: rt, clusterId: cluster, tierRank: tier });
        }
      }
    }

    accessPoints.sort((a, c) => c.tierRank - a.tierRank);
    b.connectedRoadCluster = bestCluster;
    b.congestionFactor = bestCluster > 0 ? (this.clusterCongestionMap.get(bestCluster) ?? 1.0) : 1.0;

    const info: BuildingRoadAccessInfo = {
      connectedCluster: bestCluster,
      bestRoadTier: bestTier,
      heavyTruckSuitable,
      accessPoints,
    };
    this.buildingAccessMap.set(b.id, info);
    return info;
  }

  public getCachedRoadAccess(b: BuildingInstance, chunks: ChunkManager): BuildingRoadAccessInfo {
    const cached = this.buildingAccessMap.get(b.id);
    if (cached !== undefined && !this.roadDirty) {
      return cached;
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
    const existingLocal = b.congestionFactor ?? 1.0;
    b.congestionFactor = Number(Math.min(base, Math.max(0.55, existingLocal)).toFixed(2));
    return b.congestionFactor;
  }

  public getBuildingLogisticsMultiplier(b: BuildingInstance, state: WorldEngineState, chunks: ChunkManager): number {
    const { bestRoadTier } = this.getCachedRoadAccess(b, chunks);
    let base = 1.0;
    if (bestRoadTier > 0) {
      const roadDef = Object.values(ROADS).find((r) => (r.tierRank ?? r.id) === bestRoadTier) ?? ROADS[bestRoadTier as RoadType];
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

  public getNetworkSummary(activeVehicles = 0): RoadNetworkSummary {
    let networkCount = 0;
    let disconnectedSegments = 0;
    let disconnectedClusters = 0;

    for (const info of this.clusterStatsMap.values()) {
      if (info.roadClass !== 'road') continue;
      networkCount++;
      if (info.isDisconnected) {
        disconnectedClusters++;
        disconnectedSegments += info.count;
      }
    }

    let congestedTiles = 0;
    let sumCong = 0;
    for (const val of this.tileCongestionMap.values()) {
      sumCong += val;
      if (val >= 0.6) congestedTiles++;
    }

    const avgCongestionPct =
      this.totalRoadTiles > 0 ? Math.min(100, Math.round((sumCong / this.totalRoadTiles) * 100)) : 0;

    return {
      totalRoadTiles: this.totalRoadTiles,
      totalRailTiles: this.totalRailTiles,
      networkCount,
      mainNetworkId: this.mainNetworkId,
      mainNetworkSize: this.mainNetworkSize,
      disconnectedSegments,
      disconnectedClusters,
      congestedTiles,
      activeVehicles,
      avgCongestionPct,
    };
  }
}
