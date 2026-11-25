import { BUILDINGS, getBuildingFootprint, getBuildingLevelMultiplier } from '../data/buildings.data';
import type { ChunkManager } from '../core/ChunkManager';
import { BuildingInstance, TileFlag, UtilityFlag, WorldEngineState } from '../core/GameState';
import { CHUNK_SIZE, gridToChunk } from '../core/IsoMath';
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

/**
 * Two-stage utility evaluator:
 * 1) Physical Network Connectivity (BFS over PowerLine/PowerSubstation & WaterPipe/WaterPump;
 *    roads NEVER auto-bridge electricity or water).
 * 2) Per-Network Production vs Demand Capacity (so connected buildings still suffer
 *    brownouts/shortages when connected capacity < connected demand).
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

  public static evaluateNetworks(
    state: WorldEngineState,
    chunks: ChunkManager,
    climate: ClimateModifiers
  ): void {
    // Index all non-constructing buildings onto a tile map so networks can jump across connected buildings
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

    // Collect utility tiles from modified chunks
    const powerTiles = new Set<string>();
    const substationCenters: Array<{ gx: number; gy: number }> = [];
    const waterTiles = new Set<string>();
    const pumpCenters: Array<{ gx: number; gy: number }> = [];

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
            if ((u & UtilityFlag.PowerSubstation) !== 0) substationCenters.push({ gx, gy });
          }
          if ((u & (UtilityFlag.WaterPipe | UtilityFlag.WaterPump)) !== 0) {
            waterTiles.add(key);
            if ((u & UtilityFlag.WaterPump) !== 0) pumpCenters.push({ gx, gy });
          }
        }
      }
    }

    // --- 1. POWER NETWORK FLOOD FILL ---
    const powerTileNet = new Map<string, number>();
    const powerGenByNet = new Map<number, number>();
    const powerDemByNet = new Map<number, number>();
    const visitedPowerBuildings = new Set<number>();
    let nextPowerNetId = 1;

    const powerSources = state.buildings.filter((b) => {
      if (b.status === 'constructing' || !b.enabled) return false;
      const def = BUILDINGS[b.defId];
      return Boolean(def?.powerOutput && def.powerOutput > 0);
    });

    const getEffectivePowerOutput = (b: BuildingInstance): number => {
      const def = BUILDINGS[b.defId];
      if (!def?.powerOutput || !b.enabled) return 0;
      const lvl = getBuildingLevelMultiplier(b.level, def);
      let p = def.powerOutput * lvl;
      if (b.defId === 'wind_turbine') p *= climate.windPowerMult;
      if (b.defId === 'solar_array') p *= climate.solarPowerMult;
      if (b.defId === 'coal_power_plant') {
        if (b.assignedWorkers < def.minWorkers || state.resources.coal < 1) return 0;
      }
      return Math.round(p);
    };

    for (const src of powerSources) {
      if (visitedPowerBuildings.has(src.id)) continue;
      const netId = nextPowerNetId++;
      let netGen = 0;
      let netDem = 0;

      const queue: Array<{ gx: number; gy: number }> = [];
      const enqueuedTiles = new Set<string>();

      const addBuildingToPowerNet = (b: BuildingInstance) => {
        if (visitedPowerBuildings.has(b.id)) return;
        visitedPowerBuildings.add(b.id);
        b.powerConnected = true;
        b.powerNetworkId = netId;
        const def = BUILDINGS[b.defId];
        if (!def) return;
        netGen += getEffectivePowerOutput(b);
        if (def.powerDemand && b.enabled) netDem += def.powerDemand;

        const fp = getBuildingFootprint(def, b.rotation ?? 0);
        // Building taps utility lines on or orthogonally adjacent to its footprint, plus local 3-tile generator aura
        const aura = def.powerOutput ? 3 : 1;
        for (let dx = -aura; dx < fp.width + aura; dx++) {
          for (let dy = -aura; dy < fp.height + aura; dy++) {
            const tx = b.gx + dx;
            const ty = b.gy + dy;
            const tk = `${tx}:${ty}`;
            if (enqueuedTiles.has(tk)) continue;
            // Direct footprint overlap or orthogonal 1-tile adjacency taps PowerLine or other nearby buildings inside generator aura
            const inFootprint = dx >= 0 && dx < fp.width && dy >= 0 && dy < fp.height;
            const orthoBorder =
              ((dx === -1 || dx === fp.width) && dy >= 0 && dy < fp.height) ||
              ((dy === -1 || dy === fp.height) && dx >= 0 && dx < fp.width);

            if (inFootprint || orthoBorder || def.powerOutput) {
              if (powerTiles.has(tk) || inFootprint || (def.powerOutput && tileToBuilding.has(tk))) {
                enqueuedTiles.add(tk);
                queue.push({ gx: tx, gy: ty });
              }
            }
          }
        }
      };

      addBuildingToPowerNet(src);

      while (queue.length > 0) {
        const cur = queue.pop()!;
        const ck = `${cur.gx}:${cur.gy}`;
        if (!powerTileNet.has(ck)) powerTileNet.set(ck, netId);

        // Spread through buildings touching this tile
        const bList = tileToBuilding.get(ck);
        if (bList) {
          for (const nb of bList) addBuildingToPowerNet(nb);
        }

        // Spread along orthogonal PowerLine tiles & neighboring buildings touching PowerLine tiles
        if (powerTiles.has(ck)) {
          for (const [dx, dy] of DIRS) {
            const nx = cur.gx + dx;
            const ny = cur.gy + dy;
            const nk = `${nx}:${ny}`;
            if (!enqueuedTiles.has(nk) && (powerTiles.has(nk) || tileToBuilding.has(nk))) {
              enqueuedTiles.add(nk);
              queue.push({ gx: nx, gy: ny });
            }
          }
          // Substations distribute power wirelessly in a 5-tile Manhattan radius
          if (substationCenters.some((s) => s.gx === cur.gx && s.gy === cur.gy)) {
            for (let rx = -5; rx <= 5; rx++) {
              for (let ry = -5; ry <= 5; ry++) {
                if (Math.abs(rx) + Math.abs(ry) > 5) continue;
                const sk = `${cur.gx + rx}:${cur.gy + ry}`;
                const sBldgs = tileToBuilding.get(sk);
                if (sBldgs) {
                  for (const sb of sBldgs) addBuildingToPowerNet(sb);
                }
              }
            }
          }
        }
      }

      powerGenByNet.set(netId, netGen);
      powerDemByNet.set(netId, netDem);
    }

    // Mark disconnected buildings cleanly & set per-network satisfaction
    let totalPowerGen = 0;
    let totalPowerDem = 0;
    let pConn = 0;
    let pDisc = 0;
    let pBrownout = 0;

    for (const g of powerGenByNet.values()) totalPowerGen += g;

    for (const b of state.buildings) {
      if (b.status === 'constructing') continue;
      const def = BUILDINGS[b.defId];
      if (!def) continue;

      if (!visitedPowerBuildings.has(b.id)) {
        b.powerConnected = false;
        b.powerNetworkId = 0;
        b.powerSatisfaction = def.powerDemand ? 0 : 1;
        if (def.powerDemand && b.enabled) {
          totalPowerDem += def.powerDemand;
          pDisc++;
        }
      } else {
        const netId = b.powerNetworkId ?? 0;
        const g = powerGenByNet.get(netId) ?? 0;
        const d = powerDemByNet.get(netId) ?? 0;
        const sat = d === 0 ? 1 : g >= d ? 1 : Math.max(0.2, g / Math.max(1, d));
        b.powerSatisfaction = sat;
        if (def.powerDemand && b.enabled) {
          totalPowerDem += def.powerDemand;
          pConn++;
          if (sat < 1) pBrownout++;
        }
      }
    }

    state.powerGenerated = totalPowerGen;
    state.powerDemand = totalPowerDem;

    // --- 2. WATER NETWORK FLOOD FILL ---
    const visitedWaterBuildings = new Set<number>();
    const waterGenByNet = new Map<number, number>();
    const waterDemByNet = new Map<number, number>();
    let nextWaterNetId = 1;

    const waterSources = state.buildings.filter((b) => {
      if (b.status === 'constructing' || !b.enabled) return false;
      const def = BUILDINGS[b.defId];
      return Boolean(def?.waterOutput && def.waterOutput > 0);
    });

    for (const src of waterSources) {
      if (visitedWaterBuildings.has(src.id)) continue;
      const netId = nextWaterNetId++;
      let netGen = 0;
      let netDem = 0;
      const queue: Array<{ gx: number; gy: number }> = [];
      const enqueued = new Set<string>();

      const addBuildingToWaterNet = (b: BuildingInstance) => {
        if (visitedWaterBuildings.has(b.id)) return;
        visitedWaterBuildings.add(b.id);
        b.waterConnected = true;
        b.waterNetworkId = netId;
        const def = BUILDINGS[b.defId];
        if (!def) return;
        const lvl = getBuildingLevelMultiplier(b.level, def);
        if (def.waterOutput && b.enabled) netGen += Math.round(def.waterOutput * lvl);
        if (def.waterDemand && b.enabled) netDem += Math.round(def.waterDemand * climate.waterDemandMult);

        const fp = getBuildingFootprint(def, b.rotation ?? 0);
        // Wells & water sources serve a natural 4-tile local radius; pipes extend indefinitely
        const aura = def.waterOutput ? 4 : 1;
        for (let dx = -aura; dx < fp.width + aura; dx++) {
          for (let dy = -aura; dy < fp.height + aura; dy++) {
            const tx = b.gx + dx;
            const ty = b.gy + dy;
            const tk = `${tx}:${ty}`;
            if (enqueued.has(tk)) continue;
            const inFootprint = dx >= 0 && dx < fp.width && dy >= 0 && dy < fp.height;
            const orthoBorder =
              ((dx === -1 || dx === fp.width) && dy >= 0 && dy < fp.height) ||
              ((dy === -1 || dy === fp.height) && dx >= 0 && dx < fp.width);

            if (inFootprint || orthoBorder || def.waterOutput) {
              if (waterTiles.has(tk) || inFootprint || (def.waterOutput && tileToBuilding.has(tk))) {
                enqueued.add(tk);
                queue.push({ gx: tx, gy: ty });
              }
            }
          }
        }
      };

      addBuildingToWaterNet(src);

      while (queue.length > 0) {
        const cur = queue.pop()!;
        const ck = `${cur.gx}:${cur.gy}`;
        const bList = tileToBuilding.get(ck);
        if (bList) {
          for (const nb of bList) addBuildingToWaterNet(nb);
        }

        if (waterTiles.has(ck)) {
          for (const [dx, dy] of DIRS) {
            const nk = `${cur.gx + dx}:${cur.gy + dy}`;
            if (!enqueued.has(nk) && (waterTiles.has(nk) || tileToBuilding.has(nk))) {
              enqueued.add(nk);
              queue.push({ gx: cur.gx + dx, gy: cur.gy + dy });
            }
          }
          if (pumpCenters.some((p) => p.gx === cur.gx && p.gy === cur.gy)) {
            for (let rx = -5; rx <= 5; rx++) {
              for (let ry = -5; ry <= 5; ry++) {
                if (Math.abs(rx) + Math.abs(ry) > 5) continue;
                const pk = `${cur.gx + rx}:${cur.gy + ry}`;
                const pBldgs = tileToBuilding.get(pk);
                if (pBldgs) {
                  for (const pb of pBldgs) addBuildingToWaterNet(pb);
                }
              }
            }
          }
        }
      }

      waterGenByNet.set(netId, netGen);
      waterDemByNet.set(netId, netDem);
    }

    let wConn = 0;
    let wDisc = 0;
    let wShortage = 0;

    for (const b of state.buildings) {
      if (b.status === 'constructing') continue;
      const def = BUILDINGS[b.defId];
      if (!def) continue;

      if (!visitedWaterBuildings.has(b.id)) {
        b.waterConnected = false;
        b.waterNetworkId = 0;
        b.waterSatisfaction = def.waterDemand ? 0 : 1;
        if (def.waterDemand && b.enabled) wDisc++;
      } else {
        const netId = b.waterNetworkId ?? 0;
        const g = waterGenByNet.get(netId) ?? 0;
        const d = waterDemByNet.get(netId) ?? 0;
        const sat = d === 0 ? 1 : g >= d ? 1 : Math.max(0.2, g / Math.max(1, d));
        b.waterSatisfaction = sat;
        if (def.waterDemand && b.enabled) {
          wConn++;
          if (sat < 1) wShortage++;
        }
      }
    }

    // Ensure tile grid chunk coords remain valid even when no pipes placed
    void gridToChunk;
    state.utilitySummary = {
      powerConnectedCount: pConn,
      powerDisconnectedCount: pDisc,
      powerBrownoutCount: pBrownout,
      waterConnectedCount: wConn,
      waterDisconnectedCount: wDisc,
      waterShortageCount: wShortage,
      serviceCoveragePct: state.utilitySummary?.serviceCoveragePct ?? 0,
    };
  }
}
