import { BUILDINGS, getBuildingFootprint } from '../data/buildings.data';
import { getRoadProperties, ROADS, RoadType } from '../data/roads.data';
import type { ChunkManager } from '../core/ChunkManager';
import { BuildingInstance, RoadDirection, TileFlag, WorldEngineState } from '../core/GameState';
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
  /** Junction registry size (logical intersections discovered from the graph). */
  junctionCount: number;
  signalizedJunctions: number;
  /** Connector structures that actually bridge owned <-> locked networks. */
  activeConnectors: number;
  danglingEndpoints: number;
}

/** A logical road graph node: one road tile plus its resolved neighbours. */
export interface RoadGraphNode {
  gx: number;
  gy: number;
  roadType: RoadType;
  clusterId: number;
  /** Bitmask of connected directions (1=N, 2=E, 4=S, 8=W). */
  mask: number;
  /** Road tiles this node can actually be driven to (layer-1 truth). */
  neighbours: string[];
  unlocked: boolean;
  /** True when this tile participates in a Connector bridge. */
  isConnector: boolean;
}

export interface JunctionRecord {
  gx: number;
  gy: number;
  kind: IntersectionKind;
  arms: number;
  signalized: boolean;
  clusterId: number;
}

const MASK_TO_DIR: ReadonlyArray<{ bit: number; dx: number; dy: number }> = [
  { bit: 1, dx: 0, dy: -1 },
  { bit: 2, dx: 1, dy: 0 },
  { bit: 4, dx: 0, dy: 1 },
  { bit: 8, dx: -1, dy: 0 },
];

export class RoadNetworkSystem {
  public networkVersion = 1;

  private roadClusterMap = new Map<string, number>();
  private clusterStatsMap = new Map<number, RoadClusterInfo>();
  private clusterCongestionMap = new Map<number, number>();
  private tileCongestionMap = new Map<string, number>();
  private buildingAccessMap = new Map<number, BuildingRoadAccessInfo>();
  private tileToBuildingMap = new Map<string, number>();
  private totalRoadTiles = 0;
  private totalRailTiles = 0;
  private mainNetworkId = 0;
  private mainNetworkSize = 0;
  private roadDirty = true;

  // ---- Layer 1: road connectivity graph -------------------------------------
  private graphNodes = new Map<string, RoadGraphNode>();
  private junctions = new Map<string, JunctionRecord>();
  private danglingEndpoints: Array<{ gx: number; gy: number; roadType: RoadType }> = [];
  private activeConnectors: Array<{ gx: number; gy: number; bridgesOwned: boolean; bridgesLocked: boolean }> = [];
  private tileSetCache = new Map<string, RoadType>();

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

  /**
   * Rendered-connection bitmask. Delegates to the logical graph when it is
   * current (so visuals can never show a link the simulation does not have), and
   * falls back to a symmetric tile probe otherwise.
   */
  public getRoadBitmask(gx: number, gy: number, chunks: ChunkManager): number {
    const cached = this.graphNodes.get(`${gx}:${gy}`);
    if (cached) return cached.mask;

    const { chunk, index } = chunks.getTile(gx, gy);
    const rt = chunk.roadType[index] as RoadType;
    if (rt === RoadType.None) return 0;

    let mask = 0;
    for (const { bit, dx, dy } of MASK_TO_DIR) {
      if (this.areTilesConnected(gx, gy, gx + dx, gy + dy, chunks)) mask |= bit;
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

    const junction = this.junctions.get(`${gx}:${gy}`);
    if (junction) return junction.kind;

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
   * Evaluates deterministic N-S vs E-W traffic light phase at a signalized
   * intersection, with neighbours synchronised to a shared cycle.
   *
   * Design:
   *  - Adjacent signalized intersections in the same road cluster share one
   *    offset (derived from the cluster id), so a green wave is possible.
   *  - The green split is proportioned by how many lanes each axis carries, so a
   *    6-lane arterial gets a longer green than a 2-lane residential street.
   *  - Cycle: 16s base, N-S green then 1.6s clearance, E-W green then clearance.
   */
  public getSignalState(
    gx: number,
    gy: number,
    fromDx: number,
    fromDy: number,
    simTimeSec: number,
    chunks?: ChunkManager
  ): SignalState {
    let nsLanes = 1;
    let ewLanes = 1;
    let signalized = true;

    if (chunks) {
      const { chunk, index } = chunks.getTile(gx, gy);
      const rt = chunk.roadType[index] as RoadType;
      if (rt === RoadType.Roundabout || rt === RoadType.Interchange) return 'yield';
      const kind = this.getIntersectionKind(gx, gy, chunks);
      if (kind !== 't_junction' && kind !== 'cross') return 'none';
      if (!getRoadProperties(rt).supportsSignals) return 'yield';
      signalized = true;

      // Count lanes arriving from each axis for the green split.
      nsLanes = 0;
      ewLanes = 0;
      for (const [dx, dy] of [[0, -1], [0, 1], [1, 0], [-1, 0]] as const) {
        const nb = chunks.getTile(gx + dx, gy + dy);
        const nrt = nb.chunk.roadType[nb.index] as RoadType;
        if (nrt === RoadType.None || nrt === RoadType.Rail) continue;
        const lanes = Math.max(1, getRoadProperties(nrt).lanesPerDirection);
        if (dy !== 0) nsLanes = Math.max(nsLanes, lanes);
        else ewLanes = Math.max(ewLanes, lanes);
      }
      nsLanes = Math.max(1, nsLanes);
      ewLanes = Math.max(1, ewLanes);
    }

    if (!signalized) return 'none';

    // Shared, deterministic offset per intersection so neighbouring lights drift
    // in step rather than fighting each other.
    const clusterOffset = (((gx + gy) % 2) + 2) % 2;
    const cycle = 16;
    const phase = ((simTimeSec + clusterOffset * 4.0) % cycle + cycle) % cycle;
    const totalLanes = nsLanes + ewLanes;
    const nsGreen = Math.max(4.0, Math.min(10.0, (cycle - 3.2) * (nsLanes / totalLanes)));
    const ewGreenStart = nsGreen + 1.6;
    const ewGreenSpan = cycle - ewGreenStart - 1.6;

    const movingNS = Math.abs(fromDy) >= Math.abs(fromDx);
    if (movingNS) {
      if (phase < nsGreen) return 'green';
      if (phase < nsGreen + 1.6) return 'yellow';
      return 'red';
    }
    if (phase >= ewGreenStart && phase < ewGreenStart + ewGreenSpan) return 'green';
    if (phase >= ewGreenStart + ewGreenSpan) return 'yellow';
    return 'red';
  }

  /**
   * Single source of truth for "are these two road tiles logically joined?".
   * Both tiles must exist, be the same road class, and (unless a Connector is
   * involved) be on the same ownership side. This is independent of lane width.
   */
  public areTilesConnected(
    fromGx: number,
    fromGy: number,
    toGx: number,
    toGy: number,
    chunks: ChunkManager
  ): boolean {
    if (Math.abs(fromGx - toGx) + Math.abs(fromGy - toGy) !== 1) return false;
    const a = chunks.getTile(fromGx, fromGy);
    const b = chunks.getTile(toGx, toGy);
    const aType = a.chunk.roadType[a.index] as RoadType;
    const bType = b.chunk.roadType[b.index] as RoadType;
    if (aType === RoadType.None || bType === RoadType.None) return false;
    const aRail = aType === RoadType.Rail;
    const bRail = bType === RoadType.Rail;
    if (aRail !== bRail) return false;
    if (aRail) return true;
    const aUnlocked = (a.chunk.flags[a.index] & TileFlag.Unlocked) !== 0;
    const bUnlocked = (b.chunk.flags[b.index] & TileFlag.Unlocked) !== 0;
    if (aUnlocked === bUnlocked) return true;
    // Crossing an ownership border is legal only through a Connector on one side.
    return aType === RoadType.Connector || bType === RoadType.Connector;
  }

  /**
   * Builds the connectivity graph + junction registry + dangling endpoint list.
   * Every downstream system (pathfinding, traffic, utilities diagnostics, fleet
   * dispatch) reads this instead of re-deriving connectivity from tile probes.
   */
  private buildRoadGraph(chunks: ChunkManager, tileSet: Map<string, RoadType>): void {
    this.junctions.clear();
    this.danglingEndpoints = [];
    this.activeConnectors = [];

    for (const [key, roadType] of tileSet.entries()) {
      const [gxStr, gyStr] = key.split(':');
      const gx = Number(gxStr);
      const gy = Number(gyStr);
      const neighbours: string[] = [];
      let mask = 0;

      for (const { bit, dx, dy } of MASK_TO_DIR) {
        const nk = `${gx + dx}:${gy + dy}`;
        if (!tileSet.has(nk)) continue;
        if (!this.areTilesConnected(gx, gy, gx + dx, gy + dy, chunks)) continue;
        mask |= bit;
        neighbours.push(nk);
      }

      const isConnector = roadType === RoadType.Connector;
      this.graphNodes.set(key, {
        gx,
        gy,
        roadType,
        clusterId: 0,
        mask,
        neighbours,
        unlocked: chunks.isUnlocked(gx, gy),
        isConnector,
      });

      if (roadType !== RoadType.Rail) {
        const arms = ((mask & 1) ? 1 : 0) + ((mask & 2) ? 1 : 0) + ((mask & 4) ? 1 : 0) + ((mask & 8) ? 1 : 0);
        if (arms === 1) {
          this.danglingEndpoints.push({ gx, gy, roadType });
        }
        if (arms >= 3 || roadType === RoadType.Roundabout || roadType === RoadType.Interchange) {
          let kind: IntersectionKind;
          if (roadType === RoadType.Roundabout) kind = 'roundabout';
          else if (roadType === RoadType.Interchange) kind = 'interchange';
          else if (arms === 3) kind = 't_junction';
          else kind = 'cross';
          this.junctions.set(key, {
            gx,
            gy,
            kind,
            arms,
            signalized: getRoadProperties(roadType).supportsSignals && kind !== 'roundabout' && kind !== 'interchange',
            clusterId: 0,
          });
        }
      }

      if (isConnector) {
        let bridgesOwned = false;
        let bridgesLocked = false;
        for (const { dx, dy } of MASK_TO_DIR) {
          const nk = `${gx + dx}:${gy + dy}`;
          const nType = tileSet.get(nk);
          if (nType === undefined || nType === RoadType.Rail) continue;
          if (chunks.isUnlocked(gx + dx, gy + dy)) bridgesOwned = true;
          else bridgesLocked = true;
        }
        this.activeConnectors.push({ gx, gy, bridgesOwned, bridgesLocked });
      }
    }
  }

  /** Rebuild per-junction cluster ids after clusters are resolved. */
  private stampJunctionClusters(): void {
    for (const [key, j] of this.junctions.entries()) {
      j.clusterId = this.roadClusterMap.get(key) ?? 0;
    }
  }

  public getGraphNode(gx: number, gy: number): RoadGraphNode | undefined {
    return this.graphNodes.get(`${gx}:${gy}`);
  }

  /** Neighbour tiles that can really be driven to (used by pathfinding + traffic). */
  public getConnectedNeighbours(gx: number, gy: number): string[] {
    return this.graphNodes.get(`${gx}:${gy}`)?.neighbours ?? [];
  }

  public getJunction(gx: number, gy: number): JunctionRecord | undefined {
    return this.junctions.get(`${gx}:${gy}`);
  }

  public getAllJunctions(): ReadonlyMap<string, JunctionRecord> {
    return this.junctions;
  }

  public getDanglingEndpoints(): ReadonlyArray<{ gx: number; gy: number; roadType: RoadType }> {
    return this.danglingEndpoints;
  }

  public getActiveConnectors(): ReadonlyArray<{
    gx: number;
    gy: number;
    bridgesOwned: boolean;
    bridgesLocked: boolean;
  }> {
    return this.activeConnectors;
  }

  /** True when the tile has at least one logical neighbour (i.e. is really wired in). */
  public isTileLinked(gx: number, gy: number): boolean {
    return (this.graphNodes.get(`${gx}:${gy}`)?.neighbours.length ?? 0) > 0;
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

    // ---------------------------------------------------------------------
    // Layer 1: build the authoritative road graph.
    // A logical connection exists only when BOTH tiles agree (bidirectional),
    // so stale/one-sided data can never produce a phantom connection.
    // ---------------------------------------------------------------------
    this.tileSetCache = tileSet;
    this.graphNodes.clear();
    this.buildRoadGraph(chunks, tileSet);

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

    // Flood fill clusters using the *graph* adjacency (not raw tile probing) so
    // cluster membership matches exactly what vehicles are allowed to traverse.
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
        const key = `${x}:${y}`;
        const rType = tileSet.get(key) ?? RoadType.Dirt;
        stat.count++;
        stat.speedSum += ROADS[rType]?.speedMultiplier ?? 1.0;

        const node = this.graphNodes.get(key);
        const neighbours: Array<[number, number]> = [];
        if (node) {
          for (const nk of node.neighbours) {
            const [nxStr, nyStr] = nk.split(':');
            neighbours.push([Number(nxStr), Number(nyStr)]);
          }
        } else {
          for (const [dx, dy] of dirs) neighbours.push([x + dx, y + dy]);
        }

        for (const [nx, ny] of neighbours) {
          const nk = `${nx}:${ny}`;
          const nType = tileSet.get(nk);
          if (nType !== undefined && !this.roadClusterMap.has(nk)) {
            const sameClass = rType === RoadType.Rail ? nType === RoadType.Rail : nType !== RoadType.Rail;
            if (!sameClass) continue;
            this.roadClusterMap.set(nk, clusterId);
            queue.push([nx, ny]);
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

    // Stamp resolved cluster ids onto graph nodes + junction registry so layer 1
    // consumers can answer "which network is this node on?" in O(1).
    for (const [key, node] of this.graphNodes.entries()) {
      node.clusterId = this.roadClusterMap.get(key) ?? 0;
    }
    this.stampJunctionClusters();

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
      // A network is only "disconnected" when it is an orphaned fragment: either a
      // single isolated tile, or a real cluster that does not touch the main network
      // AND has no buildings depending on it. Multiple independent networks are legal
      // (separate towns), so we report them but do not label them broken.
      const isDisconnected =
        stat.roadClass === 'road' && (stat.count <= 1 || (mainId > 0 && clusterId !== mainId));

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
        if (rt === RoadType.None) continue;
        // Rail is not road freight access. Counting it here was one of the
        // sources of the "looks connected but isn't" bug, because a rail tile
        // would satisfy requiresRoad / minRoadTier without any drivable link.
        if (rt === RoadType.Rail) continue;

        const key = `${nx}:${ny}`;
        const cluster = this.roadClusterMap.get(key) ?? 0;
        if (cluster === 0) continue; // never assume the main network
        const node = this.graphNodes.get(key);
        // A road tile with no logical link is a dead stub: a vehicle cannot
        // enter or leave it, so it is not valid access.
        const linked = (node?.neighbours.length ?? 0) > 0 || rt === RoadType.Connector;
        if (!linked) continue;

        const clusterSize = this.clusterStatsMap.get(cluster)?.count ?? 1;
        const roadDef = ROADS[rt];
        const tier = rt === RoadType.Bridge ? 2 : (roadDef?.tierRank ?? rt);
        if (clusterSize > bestClusterSize) {
          bestClusterSize = clusterSize;
          bestCluster = cluster;
        }
        if (getRoadProperties(rt).heavyTruckFriendly) {
          heavyTruckSuitable = true;
        }
        if (tier > bestTier) bestTier = tier;
        accessPoints.push({ gx: nx, gy: ny, roadType: rt, clusterId: cluster, tierRank: tier });
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

  /**
   * All logical road nodes belonging to a given cluster. Used by the forestry
   * fleet to search outward from the road network (road-first) instead of from a
   * tree centroid, which guarantees the parking spot found is actually drivable.
   */
  public getClusterNodes(clusterId: number): RoadGraphNode[] {
    if (clusterId <= 0) return [];
    const out: RoadGraphNode[] = [];
    for (const node of this.graphNodes.values()) {
      if (node.clusterId === clusterId && node.roadType !== RoadType.Rail) out.push(node);
    }
    return out;
  }

  /** All cluster ids that contain at least `minTiles` drivable road tiles. */
  public getDrivableClusterIds(): number[] {
    const out: number[] = [];
    for (const [id, info] of this.clusterStatsMap.entries()) {
      if (info.roadClass !== 'road') continue;
      if (info.count < 2) continue;
      out.push(id);
    }
    return out;
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

    let signalizedJunctions = 0;
    for (const j of this.junctions.values()) {
      if (j.signalized) signalizedJunctions++;
    }

    const activeConnectors = this.activeConnectors.filter((c) => c.bridgesOwned && c.bridgesLocked).length;

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
      junctionCount: this.junctions.size,
      signalizedJunctions,
      activeConnectors,
      danglingEndpoints: this.danglingEndpoints.length,
    };
  }

  /**
   * Layer-1 road diagnostics: returns the exact tiles that are logically
   * unconnected so the UI can explain *why* something reports as disconnected.
   */
  public diagnoseRoadNetwork(
    state: WorldEngineState,
    chunks: ChunkManager
  ): Array<{
    code: 'road_endpoint_unconnected' | 'intersection_missing' | 'connector_unlinked' | 'connector_not_on_border' | 'building_no_road_access' | 'building_road_tier_too_low';
    gx: number;
    gy: number;
    title: string;
    detail: string;
    buildingId?: number;
  }> {
    const out: Array<{
      code:
        | 'road_endpoint_unconnected'
        | 'intersection_missing'
        | 'connector_unlinked'
        | 'connector_not_on_border'
        | 'building_no_road_access'
        | 'building_road_tier_too_low';
      gx: number;
      gy: number;
      title: string;
      detail: string;
      buildingId?: number;
    }> = [];

    // Dead-end stubs whose single neighbour is not actually traversable.
    for (const ep of this.danglingEndpoints) {
      const node = this.graphNodes.get(`${ep.gx}:${ep.gy}`);
      if (!node) continue;
      const isolated = node.neighbours.length === 0;
      const clusterSize = this.clusterStatsMap.get(node.clusterId)?.count ?? 0;
      if (isolated) {
        out.push({
          code: 'road_endpoint_unconnected',
          gx: ep.gx,
          gy: ep.gy,
          title: 'Road tile has no connected neighbour',
          detail: `Tile (${ep.gx}, ${ep.gy}) is a lone ${ROADS[ep.roadType]?.name ?? 'road'} tile. Extend the road or remove it.`,
        });
      } else if (clusterSize <= 3) {
        out.push({
          code: 'road_endpoint_unconnected',
          gx: ep.gx,
          gy: ep.gy,
          title: 'Road stub is not linked to a network',
          detail: `Tile (${ep.gx}, ${ep.gy}) belongs to a ${clusterSize}-tile fragment that reaches no buildings or suppliers.`,
        });
      }
    }

    for (const c of this.activeConnectors) {
      const buildingRef = chunks.getTile(c.gx, c.gy);
      const bId = buildingRef.chunk.buildingRef[buildingRef.index];
      if (!c.bridgesOwned) {
        out.push({
          code: 'connector_unlinked',
          gx: c.gx,
          gy: c.gy,
          title: 'Connector has no owned road',
          detail: `Connector at (${c.gx}, ${c.gy}) must touch an owned road on this side of the border.`,
          buildingId: bId >= 0 ? bId : undefined,
        });
      } else if (!c.bridgesLocked) {
        out.push({
          code: 'connector_unlinked',
          gx: c.gx,
          gy: c.gy,
          title: 'Connector leads to no locked road',
          detail: `Connector at (${c.gx}, ${c.gy}) reaches locked land, but no locked-area road touches it yet.`,
          buildingId: bId >= 0 ? bId : undefined,
        });
      }
    }

    for (const b of state.buildings) {
      if (b.status === 'constructing') continue;
      const def = BUILDINGS[b.defId];
      if (!def || !def.requiresRoad) continue;
      const access = this.getCachedRoadAccess(b, chunks);
      if (access.accessPoints.length === 0) {
        out.push({
          code: 'building_no_road_access',
          gx: b.gx,
          gy: b.gy,
          title: `${def.name} has no road access`,
          detail: `No drivable road tile touches the footprint of ${def.name} (${b.gx}, ${b.gy}). Build a road on an orthogonally adjacent tile.`,
          buildingId: b.id,
        });
      } else if (def.minRoadTier && access.bestRoadTier < def.minRoadTier) {
        out.push({
          code: 'building_road_tier_too_low',
          gx: b.gx,
          gy: b.gy,
          title: `${def.name} needs a higher road tier`,
          detail: `Adjacent best road tier is ${access.bestRoadTier} but ${def.name} requires tier ${def.minRoadTier}. Upgrade the access road.`,
          buildingId: b.id,
        });
      }
    }

    return out;
  }
}
