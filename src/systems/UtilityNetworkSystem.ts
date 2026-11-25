import { BUILDINGS, getBuildingFootprint, getBuildingLevelMultiplier } from '../data/buildings.data';
import { getRoadProperties, RoadType } from '../data/roads.data';
import type { ChunkManager } from '../core/ChunkManager';
import { BuildingInstance, TileFlag, UtilityFlag, WorldEngineState } from '../core/GameState';
import { CHUNK_SIZE } from '../core/IsoMath';
import type { ClimateModifiers } from './EnvironmentSystem';

export type UtilityPlacementKind = 'power_line' | 'substation' | 'water_pipe' | 'water_pump';

const DIRS: ReadonlyArray<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export const UTILITY_COSTS: Record<UtilityPlacementKind, number> = {
  power_line: 8,
  substation: 45,
  water_pipe: 8,
  water_pump: 45,
};

/** Logical utility node. Deliberately independent of lane geometry and visuals. */
export interface UtilityNode {
  key: string;
  gx: number;
  gy: number;
  /** Network id assigned during the last evaluation (0 = orphan). */
  networkId: number;
  /** True when this node physically receives supply from a source. */
  energized: boolean;
  /** Overloaded nodes are connected but cannot carry the demand placed on them. */
  overloaded: boolean;
  /** Why this node failed, when it did. */
  reason: string;
}

interface UtilityNetwork {
  id: number;
  kind: 'power' | 'water';
  nodes: number;
  generation: number;
  demand: number;
  distributionCapacity: number;
  overloaded: boolean;
  buildings: number[];
}

/**
 * Layer 3: independent utility connectivity, distribution capacity and
 * building-level delivery.
 *
 * Key design rules (these fix the "four-lane roads break utilities" class of bug):
 *  1. Utility connectivity never depends on road width, lane count or how a road
 *     renders. Nodes are keyed by *grid coordinates* only, so upgrading a road
 *     from 2 lanes to 6 lanes cannot change a connection identifier.
 *  2. Roads are never auto-bridged to utilities. Electricity and water require
 *     explicit lines/pipes (plus the aura of substations/pumps).
 *  3. A building is only "served" when it is on a network that reaches a source
 *     AND there is distribution capacity left for it. City totals are never used
 *     as a proxy for building-level supply.
 */
export class UtilityNetworkSystem {
  public static placeUtility(
    kind: UtilityPlacementKind,
    gx: number,
    gy: number,
    state: WorldEngineState,
    chunks: ChunkManager
  ): { ok: boolean; reason?: string } {
    if (!chunks.isUnlocked(gx, gy)) {
      return { ok: false, reason: 'Unlock tile before installing utilities' };
    }
    const cost = UTILITY_COSTS[kind];
    if (state.coins < cost) {
      return { ok: false, reason: `Needs ${cost} Coins` };
    }
    const flag =
      kind === 'power_line'
        ? UtilityFlag.PowerLine
        : kind === 'substation'
          ? UtilityFlag.PowerLine | UtilityFlag.PowerSubstation
          : kind === 'water_pipe'
            ? UtilityFlag.WaterPipe
            : UtilityFlag.WaterPipe | UtilityFlag.WaterPump;

    const existing = chunks.getTileUtility(gx, gy);
    if ((existing & flag) === flag) {
      return { ok: false, reason: 'Already installed on this tile' };
    }

    state.coins -= cost;
    chunks.setTileUtilityFlag(gx, gy, flag, true);
    return { ok: true };
  }

  public static removeUtility(
    kind: 'power' | 'water',
    gx: number,
    gy: number,
    state: WorldEngineState,
    chunks: ChunkManager
  ): { ok: boolean; reason?: string } {
    if (!chunks.isUnlocked(gx, gy)) {
      return { ok: false, reason: 'Tile is locked' };
    }
    const mask =
      kind === 'power'
        ? UtilityFlag.PowerLine | UtilityFlag.PowerSubstation
        : UtilityFlag.WaterPipe | UtilityFlag.WaterPump;
    const existing = chunks.getTileUtility(gx, gy);
    if ((existing & mask) === 0) {
      return { ok: false, reason: `No ${kind} utility on this tile` };
    }
    chunks.setTileUtilityFlag(gx, gy, mask, false);
    state.coins += 4;
    return { ok: true };
  }

  /**
   * Recomputes both utility layers. Cheap enough to run every tick because it is
   * a single flood fill per source over a sparse node set.
   */
  public static evaluateNetworks(
    state: WorldEngineState,
    chunks: ChunkManager,
    climate: ClimateModifiers
  ): void {
    const tileToBuilding = new Map<string, BuildingInstance[]>();
    for (const b of state.buildings) {
      if (b.status === 'constructing') continue;
      const def = BUILDINGS[b.defId];
      if (!def) continue;
      const fp = getBuildingFootprint(def, b.rotation ?? 0);
      for (let dx = 0; dx < fp.width; dx++) {
        for (let dy = 0; dy < fp.height; dy++) {
          const k = `${b.gx + dx}:${b.gy + dy}`;
          const list = tileToBuilding.get(k);
          if (list) list.push(b);
          else tileToBuilding.set(k, [b]);
        }
      }
    }

    // ---- Collect utility nodes (grid-keyed, width independent) --------------
    const powerTiles = new Set<string>();
    const substationCenters: string[] = [];
    const waterTiles = new Set<string>();
    const pumpCenters: string[] = [];

    for (const chunk of chunks.getAllLoadedChunks()) {
      if (!chunk.isModified) continue;
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const i = ly * CHUNK_SIZE + lx;
          if ((chunk.flags[i] & TileFlag.Unlocked) === 0) continue;
          const u = chunk.utilityNet[i];
          if (u === 0) continue;
          const gx = chunk.cx * CHUNK_SIZE + lx;
          const gy = chunk.cy * CHUNK_SIZE + ly;
          const key = `${gx}:${gy}`;
          if ((u & (UtilityFlag.PowerLine | UtilityFlag.PowerSubstation)) !== 0) {
            powerTiles.add(key);
            if ((u & UtilityFlag.PowerSubstation) !== 0) substationCenters.push(key);
          }
          if ((u & (UtilityFlag.WaterPipe | UtilityFlag.WaterPump)) !== 0) {
            waterTiles.add(key);
            if ((u & UtilityFlag.WaterPump) !== 0) pumpCenters.push(key);
          }
        }
      }
    }

    // Roads that carry utility trunk paths are treated as *conduits* between
    // adjacent utility nodes only if those nodes already exist. They never
    // create utility connections on their own (roads are not wires/pipes).
    const roadConduits = new Set<string>();
    for (const chunk of chunks.getAllLoadedChunks()) {
      if (!chunk.isModified) continue;
      for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++) {
        const rt = chunk.roadType[i] as RoadType;
        if (rt === RoadType.None || rt === RoadType.Rail) continue;
        if (!getRoadProperties(rt).utilityTrunk) continue;
        const gx = chunk.cx * CHUNK_SIZE + (i % CHUNK_SIZE);
        const gy = chunk.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
        roadConduits.add(`${gx}:${gy}`);
      }
    }

    const powerResult = UtilityNetworkSystem.evaluateKind({
      kind: 'power',
      state,
      tileToBuilding,
      nodes: powerTiles,
      hubs: substationCenters,
      roadConduits,
      getOutput: (b) => UtilityNetworkSystem.getEffectivePowerOutput(b, state, climate),
      getDemand: (b) => UtilityNetworkSystem.getScaledPowerDemand(b, state),
      hasSource: (b) => (BUILDINGS[b.defId]?.powerOutput ?? 0) > 0,
      buildingFlag: 'power',
    });

    const waterResult = UtilityNetworkSystem.evaluateKind({
      kind: 'water',
      state,
      tileToBuilding,
      nodes: waterTiles,
      hubs: pumpCenters,
      roadConduits,
      getOutput: (b) => UtilityNetworkSystem.getEffectiveWaterOutput(b, state),
      getDemand: (b) =>
        UtilityNetworkSystem.getScaledWaterDemand(b, state, climate, state.activePolicies?.includes('eco_water_pact')),
      hasSource: (b) => (BUILDINGS[b.defId]?.waterOutput ?? 0) > 0,
      buildingFlag: 'water',
    });

    // ---- Publish aggregate state -------------------------------------------
    state.powerGenerated = powerResult.generation;
    state.powerDelivered = powerResult.delivered;
    state.powerDemand = powerResult.demand;
    state.waterGenerated = waterResult.generation;
    state.waterDelivered = waterResult.delivered;
    state.waterDemand = waterResult.demand;

    state.utilitySummary = {
      powerConnectedCount: powerResult.connectedBuildings,
      powerDisconnectedCount: powerResult.disconnectedBuildings,
      powerBrownoutCount: powerResult.shortageBuildings,
      waterConnectedCount: waterResult.connectedBuildings,
      waterDisconnectedCount: waterResult.disconnectedBuildings,
      waterShortageCount: waterResult.shortageBuildings,
      serviceCoveragePct: state.utilitySummary?.serviceCoveragePct ?? 0,
      powerNetworkCount: powerResult.networkCount,
      waterNetworkCount: waterResult.networkCount,
      powerDisconnectedTiles: powerResult.orphanNodes,
      waterDisconnectedTiles: waterResult.orphanNodes,
      powerOverloadedNetworks: powerResult.overloadedNetworks,
      waterOverloadedNetworks: waterResult.overloadedNetworks,
    };
  }

  // ---------------------------------------------------------------------------
  // Shared network evaluator for both utilities
  // ---------------------------------------------------------------------------

  private static evaluateKind(args: {
    kind: 'power' | 'water';
    state: WorldEngineState;
    tileToBuilding: Map<string, BuildingInstance[]>;
    nodes: Set<string>;
    hubs: string[];
    roadConduits: Set<string>;
    getOutput: (b: BuildingInstance) => number;
    getDemand: (b: BuildingInstance) => number;
    hasSource: (b: BuildingInstance) => boolean;
    buildingFlag: 'power' | 'water';
  }): {
    generation: number;
    delivered: number;
    demand: number;
    connectedBuildings: number;
    disconnectedBuildings: number;
    shortageBuildings: number;
    networkCount: number;
    orphanNodes: number;
    overloadedNetworks: number;
    networks: UtilityNetwork[];
  } {
    const { state, tileToBuilding, nodes, hubs, roadConduits, kind } = args;
    const hubSet = new Set(hubs);
    /** Every utility tile reached by a source flood fill. */
    const visitedNodes = new Set<string>();
    // Indexed lookups: the flood fill runs every tick, so no repeated linear
    // scans over the building list are allowed here.
    const buildingById = new Map<number, BuildingInstance>();
    for (const b of state.buildings) buildingById.set(b.id, b);
    const hubPoints = hubs.map((h) => {
      const [hx, hy] = h.split(':').map(Number);
      return { hx, hy };
    });
    const hubNearBuilding = (b: BuildingInstance, maxManhattan: number): boolean => {
      for (const h of hubPoints) {
        if (Math.abs(h.hx - b.gx) + Math.abs(h.hy - b.gy) <= maxManhattan) return true;
      }
      return false;
    };
    const visitedBuildings = new Set<number>();
    const networks: UtilityNetwork[] = [];
    let nextNetId = 1;

    const sources = state.buildings.filter((b) => {
      if (b.status === 'constructing' || !b.enabled) return false;
      return args.hasSource(b);
    });

    const assignBuilding = (
      b: BuildingInstance,
      net: UtilityNetwork,
      queue: Array<{ key: string; gx: number; gy: number }>,
      enqueued: Set<string>
    ) => {
      if (visitedBuildings.has(b.id)) return;
      visitedBuildings.add(b.id);
      net.buildings.push(b.id);
      net.generation += args.getOutput(b);
      net.demand += args.getDemand(b);

      const def = BUILDINGS[b.defId];
      if (!def) return;
      const fp = getBuildingFootprint(def, b.rotation ?? 0);
      const isSource = args.hasSource(b);
      // Sources project a real aura (power 3 / water 4 manhattan) so a plant
      // "wires up" any line drawn near it. Ordinary buildings only connect
      // through a node orthogonally touching their footprint. Previously the
      // aura was computed but never used, which is exactly how a generator
      // sitting two tiles from its own power line reported as disconnected.
      const aura = isSource ? (kind === 'power' ? 3 : 4) : 0;

      for (let dx = -1 - aura; dx <= fp.width + aura; dx++) {
        for (let dy = -1 - aura; dy <= fp.height + aura; dy++) {
          const tx = b.gx + dx;
          const ty = b.gy + dy;
          const tk = `${tx}:${ty}`;
          if (enqueued.has(tk)) continue;

          const inFootprint = dx >= 0 && dx < fp.width && dy >= 0 && dy < fp.height;
          const orthoBorder =
            ((dx === -1 || dx === fp.width) && dy >= 0 && dy < fp.height) ||
            ((dy === -1 || dy === fp.height) && dx >= 0 && dx < fp.width);

          // Distance from the footprint rectangle to this tile, in manhattan steps.
          let outside = 0;
          if (dx < 0) outside += -dx;
          else if (dx >= fp.width) outside += dx - fp.width + 1;
          if (dy < 0) outside += -dy;
          else if (dy >= fp.height) outside += dy - fp.height + 1;

          const inAura = isSource && outside <= aura;
          if (!inFootprint && !orthoBorder && !inAura) continue;
          // Only advance the flood fill through real utility nodes. Footprint
          // tiles are seeded so the building itself is registered on the net.
          if (nodes.has(tk) || inFootprint) {
            enqueued.add(tk);
            queue.push({ key: tk, gx: tx, gy: ty });
          }
        }
      }
    };

    for (const src of sources) {
      if (visitedBuildings.has(src.id)) continue;
      const net: UtilityNetwork = {
        id: nextNetId++,
        kind,
        nodes: 0,
        generation: 0,
        demand: 0,
        distributionCapacity: 0,
        overloaded: false,
        buildings: [],
      };
      const queue: Array<{ key: string; gx: number; gy: number }> = [];
      const enqueued = new Set<string>();
      assignBuilding(src, net, queue, enqueued);

      while (queue.length > 0) {
        const cur = queue.pop()!;
        if (nodes.has(cur.key)) {
          net.nodes++;
          visitedNodes.add(cur.key);
        }

        const bList = tileToBuilding.get(cur.key);
        if (bList) for (const nb of bList) assignBuilding(nb, net, queue, enqueued);

        // Connectivity is purely orthogonal node-to-node. No lane/width checks.
        if (nodes.has(cur.key)) {
          for (const [dx, dy] of DIRS) {
            const nk = `${cur.gx + dx}:${cur.gy + dy}`;
            if (enqueued.has(nk)) continue;
            if (nodes.has(nk) || tileToBuilding.has(nk) || roadConduits.has(nk)) {
              if (!nodes.has(nk) && !tileToBuilding.has(nk)) continue;
              enqueued.add(nk);
              queue.push({ key: nk, gx: cur.gx + dx, gy: cur.gy + dy });
            }
          }
          if (hubSet.has(cur.key)) {
            for (let rx = -5; rx <= 5; rx++) {
              for (let ry = -5; ry <= 5; ry++) {
                if (Math.abs(rx) + Math.abs(ry) > 5) continue;
                const sk = `${cur.gx + rx}:${cur.gy + ry}`;
                const list = tileToBuilding.get(sk);
                if (list) for (const sb of list) assignBuilding(sb, net, queue, enqueued);
              }
            }
          }
        }
      }

      const netBuildings = net.buildings
        .map((bid) => buildingById.get(bid))
        .filter((b): b is BuildingInstance => b !== undefined);
      // A hub only counts if it actually serves a building on this network.
      const hubCount = hubPoints.filter((h) =>
        netBuildings.some((b) => Math.abs(b.gx - h.hx) <= 6 && Math.abs(b.gy - h.hy) <= 6)
      ).length;
      net.distributionCapacity = Math.max(80, net.nodes * 12 + hubCount * 85 + net.generation * 0.05);
      net.overloaded = net.demand > Math.min(net.generation, net.distributionCapacity);
      networks.push(net);
    }

    // ---- Per-building delivery ---------------------------------------------
    let totalGeneration = 0;
    for (const s of sources) totalGeneration += args.getOutput(s);
    let totalDemand = 0;
    let totalDelivered = 0;
    let connectedBuildings = 0;
    let disconnectedBuildings = 0;
    let shortageBuildings = 0;

    const netById = new Map<number, UtilityNetwork>();
    for (const n of networks) netById.set(n.id, n);
    const netOfBuilding = new Map<number, number>();
    for (const n of networks) for (const bid of n.buildings) netOfBuilding.set(bid, n.id);

    const buildingHasNodeNeighbour = (b: BuildingInstance): boolean => {
      const def = BUILDINGS[b.defId];
      if (!def) return false;
      const fp = getBuildingFootprint(def, b.rotation ?? 0);
      for (let dx = -1; dx <= fp.width; dx++) {
        for (let dy = -1; dy <= fp.height; dy++) {
          if (nodes.has(`${b.gx + dx}:${b.gy + dy}`)) return true;
        }
      }
      return hubNearBuilding(b, 6);
    };

    for (const b of state.buildings) {
      if (b.status === 'constructing') continue;
      const demand = args.getDemand(b);
      const netId = netOfBuilding.get(b.id);
      const net = netId !== undefined ? netById.get(netId) : undefined;

      if (!b.enabled) {
        if (args.buildingFlag === 'power') {
          b.powerConnected = net !== undefined;
          b.powerSatisfaction = demand > 0 ? 0 : 1;
          b.powerNetworkId = net?.id ?? 0;
          b.powerReason = 'ok';
        } else {
          b.waterConnected = net !== undefined;
          b.waterSatisfaction = demand > 0 ? 0 : 1;
          b.waterNetworkId = net?.id ?? 0;
          b.waterReason = 'ok';
        }
        continue;
      }

      if (!net) {
        if (demand > 0) {
          totalDemand += demand;
          disconnectedBuildings++;
        }
        const touches = buildingHasNodeNeighbour(b);
        const reason = demand === 0 ? 'ok' : touches ? 'disconnected_section_no_source' : 'not_connected_to_network';
        if (args.buildingFlag === 'power') {
          b.powerConnected = false;
          b.powerNetworkId = 0;
          b.powerSatisfaction = demand > 0 ? 0 : 1;
          b.powerReason = reason as BuildingInstance['powerReason'];
        } else {
          b.waterConnected = false;
          b.waterNetworkId = 0;
          b.waterSatisfaction = demand > 0 ? 0 : 1;
          b.waterReason = reason as BuildingInstance['waterReason'];
        }
        continue;
      }

      const effectiveCap = Math.min(net.generation, net.distributionCapacity);
      const satisfaction =
        net.demand <= 0 ? 1 : net.generation <= 0 ? 0 : Math.min(1, effectiveCap / net.demand);

      if (args.buildingFlag === 'power') {
        b.powerConnected = true;
        b.powerNetworkId = net.id;
        b.powerSatisfaction = satisfaction;
      } else {
        b.waterConnected = true;
        b.waterNetworkId = net.id;
        b.waterSatisfaction = satisfaction;
      }

      if (demand > 0) {
        totalDemand += demand;
        totalDelivered += Math.round(demand * satisfaction);
        connectedBuildings++;
        if (satisfaction < 0.999) shortageBuildings++;
      }

      // Report the binding constraint, not just "not enough":
      //  source_inactive        -> the network has no live generator/pump at all
      //  distribution_overloaded -> supply exists, the lines/hubs cannot carry it
      //  insufficient_supply    -> supply itself is below demand
      const reason =
        satisfaction >= 0.999 || demand === 0
          ? 'ok'
          : net.generation <= 0 && net.nodes > 0
            ? 'source_inactive'
            : net.demand > net.distributionCapacity
              ? 'distribution_overloaded'
              : 'insufficient_supply';
      if (args.buildingFlag === 'power') {
        b.powerReason = reason as BuildingInstance['powerReason'];
      } else {
        b.waterReason = reason as BuildingInstance['waterReason'];
      }
    }

    // Orphan nodes: utility tiles that no flood fill reached (they are physically
    // installed but have no path to any source). Collected during the fill, so
    // this is O(nodes) rather than O(nodes × networks × buildings).
    let orphanNodes = 0;
    for (const key of nodes) {
      if (!visitedNodes.has(key)) orphanNodes++;
    }

    return {
      generation: totalGeneration,
      delivered: totalDelivered,
      demand: totalDemand,
      connectedBuildings,
      disconnectedBuildings,
      shortageBuildings,
      networkCount: networks.length,
      orphanNodes,
      overloadedNetworks: networks.filter((n) => n.overloaded).length,
      networks,
    };
  }

  // ---------------------------------------------------------------------------
  // Source / demand scaling (unchanged semantics, kept centralised)
  // ---------------------------------------------------------------------------

  private static getEffectivePowerOutput(
    b: BuildingInstance,
    state: WorldEngineState,
    climate: ClimateModifiers
  ): number {
    const def = BUILDINGS[b.defId];
    if (!def?.powerOutput || !b.enabled) return 0;
    if (def.minWorkers > 0 && b.assignedWorkers < def.minWorkers) return 0;
    const lvl = getBuildingLevelMultiplier(b.level, def);
    let p = def.powerOutput * lvl;
    if (b.defId === 'wind_turbine') p *= climate.windPowerMult;
    if (b.defId === 'solar_array') p *= climate.solarPowerMult;
    if (b.defId === 'coal_power_plant' && state.resources.coal < 1) return 0;
    return Math.round(p);
  }

  private static getScaledPowerDemand(b: BuildingInstance, _state: WorldEngineState): number {
    const def = BUILDINGS[b.defId];
    if (!def?.powerDemand || !b.enabled) return 0;
    return Math.round(def.powerDemand * getBuildingLevelMultiplier(b.level, def));
  }

  private static getEffectiveWaterOutput(b: BuildingInstance, _state: WorldEngineState): number {
    const def = BUILDINGS[b.defId];
    if (!def?.waterOutput || !b.enabled) return 0;
    if (def.minWorkers > 0 && b.assignedWorkers < def.minWorkers) return 0;
    return Math.round(def.waterOutput * getBuildingLevelMultiplier(b.level, def));
  }

  private static getScaledWaterDemand(
    b: BuildingInstance,
    _state: WorldEngineState,
    climate: ClimateModifiers,
    ecoPact: boolean
  ): number {
    const def = BUILDINGS[b.defId];
    if (!def?.waterDemand || !b.enabled) return 0;
    const cut = ecoPact ? 0.75 : 1.0;
    return Math.max(
      1,
      Math.round(def.waterDemand * getBuildingLevelMultiplier(b.level, def) * climate.waterDemandMult * cut)
    );
  }

  /**
   * Utility diagnostics: identifies the exact node/building responsible for a
   * failure instead of a vague "disconnected" warning.
   */
  public static diagnoseUtilities(
    state: WorldEngineState,
    chunks: ChunkManager
  ): Array<{
    kind: 'power' | 'water';
    code:
      | 'utility_no_supplier'
      | 'utility_disconnected'
      | 'utility_distribution_overloaded'
      | 'utility_insufficient_supply';
    gx: number;
    gy: number;
    buildingId?: number;
    title: string;
    detail: string;
  }> {
    const out: Array<{
      kind: 'power' | 'water';
      code:
        | 'utility_no_supplier'
        | 'utility_disconnected'
        | 'utility_distribution_overloaded'
        | 'utility_insufficient_supply';
      gx: number;
      gy: number;
      buildingId?: number;
      title: string;
      detail: string;
    }> = [];

    for (const b of state.buildings) {
      if (b.status === 'constructing') continue;
      const def = BUILDINGS[b.defId];
      if (!def) continue;

      const powerDemand = UtilityNetworkSystem.getScaledPowerDemand(b, state);
      if (powerDemand > 0) {
        if (!b.powerConnected) {
          out.push({
            kind: 'power',
            code: 'utility_disconnected',
            gx: b.gx,
            gy: b.gy,
            buildingId: b.id,
            title: `${def.name} has no power connection`,
            detail:
              b.powerReason === 'disconnected_section_no_source'
                ? `A power line touches ${def.name} but that line section reaches no generator. Extend the line to a plant or substation.`
                : `No power line touches ${def.name}. Run a line from a generator/substation to the footprint.`,
          });
        } else if ((b.powerSatisfaction ?? 0) < 0.999) {
          out.push({
            kind: 'power',
            code:
              b.powerReason === 'distribution_overloaded'
                ? 'utility_distribution_overloaded'
                : b.powerReason === 'source_inactive'
                  ? 'utility_no_supplier'
                  : 'utility_insufficient_supply',
            gx: b.gx,
            gy: b.gy,
            buildingId: b.id,
            title: `${def.name} is under-powered`,
            detail:
              b.powerReason === 'distribution_overloaded'
                ? `Network #${b.powerNetworkId} distribution capacity is exceeded. Add a substation near this building.`
                : b.powerReason === 'source_inactive'
                  ? `Network #${b.powerNetworkId} has a generator with no output (missing workers or fuel).`
                  : `Network #${b.powerNetworkId} generation cannot cover connected demand. Build more generation.`,
          });
        }
      }

      const waterDemand = UtilityNetworkSystem.getScaledWaterDemand(
        b,
        state,
        { waterDemandMult: 1 } as ClimateModifiers,
        false
      );
      if (waterDemand > 0 && (def.recipe || waterDemand >= 2)) {
        if (!b.waterConnected) {
          out.push({
            kind: 'water',
            code: 'utility_disconnected',
            gx: b.gx,
            gy: b.gy,
            buildingId: b.id,
            title: `${def.name} has no water connection`,
            detail:
              b.waterReason === 'disconnected_section_no_source'
                ? `A pipe touches ${def.name} but that section reaches no pump or water tower.`
                : `No water pipe touches ${def.name}. Run a pipe from a pump/tower to the footprint.`,
          });
        } else if ((b.waterSatisfaction ?? 0) < 0.999) {
          out.push({
            kind: 'water',
            code:
              b.waterReason === 'distribution_overloaded'
                ? 'utility_distribution_overloaded'
                : b.waterReason === 'source_inactive'
                  ? 'utility_no_supplier'
                  : 'utility_insufficient_supply',
            gx: b.gx,
            gy: b.gy,
            buildingId: b.id,
            title: `${def.name} is short of water`,
            detail:
              b.waterReason === 'distribution_overloaded'
                ? `Network #${b.waterNetworkId} pipe capacity is exceeded. Add a pump or water tower.`
                : b.waterReason === 'source_inactive'
                  ? `Network #${b.waterNetworkId} has a source with no output (missing workers).`
                  : `Network #${b.waterNetworkId} production cannot cover connected demand.`,
          });
        }
      }
    }

    void chunks;
    return out;
  }

  /** Independent per-tile utility network map used by the diagnostic overlays. */
  public static buildTileNetworkMap(
    state: WorldEngineState,
    chunks: ChunkManager,
    kind: 'power' | 'water'
  ): Map<string, { networkId: number; energized: boolean; overloaded: boolean }> {
    const nodes = new Set<string>();
    const hubs = new Set<string>();
    const flag = kind === 'power' ? UtilityFlag.PowerLine | UtilityFlag.PowerSubstation : UtilityFlag.WaterPipe | UtilityFlag.WaterPump;
    const hubFlag = kind === 'power' ? UtilityFlag.PowerSubstation : UtilityFlag.WaterPump;

    for (const chunk of chunks.getAllLoadedChunks()) {
      if (!chunk.isModified) continue;
      for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++) {
        if ((chunk.flags[i] & TileFlag.Unlocked) === 0) continue;
        const u = chunk.utilityNet[i];
        if ((u & flag) === 0) continue;
        const gx = chunk.cx * CHUNK_SIZE + (i % CHUNK_SIZE);
        const gy = chunk.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
        const key = `${gx}:${gy}`;
        nodes.add(key);
        if ((u & hubFlag) !== 0) hubs.add(key);
      }
    }

    const tileToBuilding = new Map<string, BuildingInstance[]>();
    for (const b of state.buildings) {
      if (b.status === 'constructing') continue;
      const def = BUILDINGS[b.defId];
      if (!def) continue;
      const fp = getBuildingFootprint(def, b.rotation ?? 0);
      for (let dx = 0; dx < fp.width; dx++) {
        for (let dy = 0; dy < fp.height; dy++) {
          const k = `${b.gx + dx}:${b.gy + dy}`;
          const list = tileToBuilding.get(k);
          if (list) list.push(b);
          else tileToBuilding.set(k, [b]);
        }
      }
    }

    const result = new Map<string, { networkId: number; energized: boolean; overloaded: boolean }>();
    let nextId = 1;
    const visited = new Set<string>();

    for (const start of nodes) {
      if (visited.has(start)) continue;
      const netId = nextId++;
      const queue = [start];
      visited.add(start);
      const component: string[] = [];
      let hasSource = false;

      while (queue.length > 0) {
        const cur = queue.pop()!;
        component.push(cur);
        const [gx, gy] = cur.split(':').map(Number);
        const bList = tileToBuilding.get(cur);
        if (bList) {
          for (const b of bList) {
            const def = BUILDINGS[b.defId];
            const output = kind === 'power' ? def?.powerOutput ?? 0 : def?.waterOutput ?? 0;
            if (output > 0 && b.enabled && b.status !== 'constructing') hasSource = true;
          }
        }
        for (const [dx, dy] of DIRS) {
          const nk = `${gx + dx}:${gy + dy}`;
          if (!nodes.has(nk) || visited.has(nk)) continue;
          visited.add(nk);
          queue.push(nk);
        }
      }

      // A component is energized only when a live source is within its aura reach
      // of this component. A source two towns away must not light it up.
      let sourceReached = hasSource;
      if (!sourceReached) {
        const aura = kind === 'power' ? 3 : 4;
        sourceReached = state.buildings.some((b) => {
          if (b.status === 'constructing' || !b.enabled) return false;
          const def = BUILDINGS[b.defId];
          const out = kind === 'power' ? def?.powerOutput ?? 0 : def?.waterOutput ?? 0;
          if (out <= 0) return false;
          const bfp = def ? getBuildingFootprint(def, b.rotation ?? 0) : { width: 1, height: 1 };
          return component.some((key) => {
            const [gx, gy] = key.split(':').map(Number);
            const dx = gx < b.gx ? b.gx - gx : gx >= b.gx + bfp.width ? gx - (b.gx + bfp.width) + 1 : 0;
            const dy = gy < b.gy ? b.gy - gy : gy >= b.gy + bfp.height ? gy - (b.gy + bfp.height) + 1 : 0;
            return dx + dy <= aura;
          });
        });
      }
      const overloaded = sourceReached && component.length <= 1;
      for (const key of component) {
        result.set(key, { networkId: netId, energized: sourceReached, overloaded });
      }
    }
    return result;
  }
}
