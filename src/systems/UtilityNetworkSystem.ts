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
    const powerDistCapByNet = new Map<number, number>();
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
      if (def.minWorkers > 0 && b.assignedWorkers < def.minWorkers) return 0;
      const lvl = getBuildingLevelMultiplier(b.level, def);
      let p = def.powerOutput * lvl;
      if (b.defId === 'wind_turbine') p *= climate.windPowerMult;
      if (b.defId === 'solar_array') p *= climate.solarPowerMult;
      if (b.defId === 'coal_power_plant' && state.resources.coal < 1) return 0;
      return Math.round(p);
    };

    const getScaledPowerDemand = (b: BuildingInstance): number => {
      const def = BUILDINGS[b.defId];
      if (!def?.powerDemand || !b.enabled) return 0;
      return Math.round(def.powerDemand * getBuildingLevelMultiplier(b.level, def));
    };

    for (const src of powerSources) {
      if (visitedPowerBuildings.has(src.id)) continue;
      const netId = nextPowerNetId++;
      let netGen = 0;
      let netDem = 0;
      let netTiles = 0;
      let netSubstations = 0;
      let netSources = 0;

      const queue: Array<{ gx: number; gy: number }> = [];
      const enqueuedTiles = new Set<string>();

      const addBuildingToPowerNet = (b: BuildingInstance) => {
        if (visitedPowerBuildings.has(b.id)) return;
        visitedPowerBuildings.add(b.id);
        b.powerConnected = true;
        b.powerNetworkId = netId;
        const def = BUILDINGS[b.defId];
        if (!def) return;
        if (def.powerOutput && def.powerOutput > 0) netSources++;
        netGen += getEffectivePowerOutput(b);
        netDem += getScaledPowerDemand(b);

        const fp = getBuildingFootprint(def, b.rotation ?? 0);
        const aura = def.powerOutput ? 3 : 1;
        for (let dx = -aura; dx < fp.width + aura; dx++) {
          for (let dy = -aura; dy < fp.height + aura; dy++) {
            const tx = b.gx + dx;
            const ty = b.gy + dy;
            const tk = `${tx}:${ty}`;
            if (enqueuedTiles.has(tk)) continue;
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
        if (powerTiles.has(ck)) {
          netTiles++;
          if (substationCenters.some((s) => s.gx === cur.gx && s.gy === cur.gy)) netSubstations++;
        }

        const bList = tileToBuilding.get(ck);
        if (bList) {
          for (const nb of bList) addBuildingToPowerNet(nb);
        }

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
      const distCap = Math.max(80, netTiles * 12 + netSubstations * 85 + netSources * 80);
      powerDistCapByNet.set(netId, distCap);
    }

    // Secondary connectivity check to distinguish "not connected to any lines" vs "connected to line section lacking a generator"
    const hasAnyPowerLineNeighbor = (b: BuildingInstance): boolean => {
      const def = BUILDINGS[b.defId];
      if (!def) return false;
      const fp = getBuildingFootprint(def, b.rotation ?? 0);
      for (let dx = -1; dx <= fp.width; dx++) {
        for (let dy = -1; dy <= fp.height; dy++) {
          const tk = `${b.gx + dx}:${b.gy + dy}`;
          if (powerTiles.has(tk)) return true;
        }
      }
      return substationCenters.some(
        (s) => Math.abs(s.gx - b.gx) + Math.abs(s.gy - b.gy) <= 5
      );
    };

    let totalPowerGen = 0;
    let totalPowerDelivered = 0;
    let totalPowerDem = 0;
    let pConn = 0;
    let pDisc = 0;
    let pBrownout = 0;

    for (const src of powerSources) totalPowerGen += getEffectivePowerOutput(src);

    for (const b of state.buildings) {
      if (b.status === 'constructing') continue;
      const dem = getScaledPowerDemand(b);
      if (!b.enabled) {
        b.powerConnected = visitedPowerBuildings.has(b.id);
        b.powerSatisfaction = dem > 0 ? 0 : 1;
        b.powerReason = 'ok';
        continue;
      }

      if (!visitedPowerBuildings.has(b.id)) {
        b.powerConnected = false;
        b.powerNetworkId = 0;
        b.powerSatisfaction = dem > 0 ? 0 : 1;
        b.powerReason =
          dem > 0
            ? hasAnyPowerLineNeighbor(b)
              ? 'disconnected_section_no_source'
              : 'not_connected_to_network'
            : 'ok';
        if (dem > 0) {
          totalPowerDem += dem;
          pDisc++;
        }
      } else {
        const netId = b.powerNetworkId ?? 0;
        const g = powerGenByNet.get(netId) ?? 0;
        const d = powerDemByNet.get(netId) ?? 0;
        const distCap = powerDistCapByNet.get(netId) ?? 999999;
        const effectiveCap = Math.min(g, distCap);
        const sat = d === 0 ? 1 : g <= 0 ? 0 : Math.min(1, effectiveCap / d);
        b.powerSatisfaction = sat;
        if (dem > 0) {
          totalPowerDem += dem;
          totalPowerDelivered += Math.round(dem * sat);
          pConn++;
          if (sat < 1) pBrownout++;
        }
        if (sat >= 1 || dem === 0) {
          b.powerReason = 'ok';
        } else if (g <= 0) {
          b.powerReason = 'source_inactive';
        } else if (g > distCap && d > distCap) {
          b.powerReason = 'distribution_overloaded';
        } else {
          b.powerReason = 'insufficient_supply';
        }
      }
    }

    state.powerGenerated = totalPowerGen;
    state.powerDelivered = totalPowerDelivered;
    state.powerDemand = totalPowerDem;

    // --- 2. WATER NETWORK FLOOD FILL ---
    const visitedWaterBuildings = new Set<number>();
    const waterGenByNet = new Map<number, number>();
    const waterDemByNet = new Map<number, number>();
    const waterDistCapByNet = new Map<number, number>();
    let nextWaterNetId = 1;

    const waterSources = state.buildings.filter((b) => {
      if (b.status === 'constructing' || !b.enabled) return false;
      const def = BUILDINGS[b.defId];
      return Boolean(def?.waterOutput && def.waterOutput > 0);
    });

    const getEffectiveWaterOutput = (b: BuildingInstance): number => {
      const def = BUILDINGS[b.defId];
      if (!def?.waterOutput || !b.enabled) return 0;
      if (def.minWorkers > 0 && b.assignedWorkers < def.minWorkers) return 0;
      return Math.round(def.waterOutput * getBuildingLevelMultiplier(b.level, def));
    };

    const waterPolicyCut = state.activePolicies?.includes('eco_water_pact') ? 0.75 : 1.0;
    const getScaledWaterDemand = (b: BuildingInstance): number => {
      const def = BUILDINGS[b.defId];
      if (!def?.waterDemand || !b.enabled) return 0;
      return Math.max(
        1,
        Math.round(def.waterDemand * getBuildingLevelMultiplier(b.level, def) * climate.waterDemandMult * waterPolicyCut)
      );
    };

    for (const src of waterSources) {
      if (visitedWaterBuildings.has(src.id)) continue;
      const netId = nextWaterNetId++;
      let netGen = 0;
      let netDem = 0;
      let netTiles = 0;
      let netPumps = 0;
      let netSources = 0;
      const queue: Array<{ gx: number; gy: number }> = [];
      const enqueued = new Set<string>();

      const addBuildingToWaterNet = (b: BuildingInstance) => {
        if (visitedWaterBuildings.has(b.id)) return;
        visitedWaterBuildings.add(b.id);
        b.waterConnected = true;
        b.waterNetworkId = netId;
        const def = BUILDINGS[b.defId];
        if (!def) return;
        if (def.waterOutput && def.waterOutput > 0) netSources++;
        netGen += getEffectiveWaterOutput(b);
        netDem += getScaledWaterDemand(b);

        const fp = getBuildingFootprint(def, b.rotation ?? 0);
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
        if (waterTiles.has(ck)) {
          netTiles++;
          if (pumpCenters.some((p) => p.gx === cur.gx && p.gy === cur.gy)) netPumps++;
        }

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
      const distCap = Math.max(80, netTiles * 12 + netPumps * 85 + netSources * 80);
      waterDistCapByNet.set(netId, distCap);
    }

    const hasAnyWaterPipeNeighbor = (b: BuildingInstance): boolean => {
      const def = BUILDINGS[b.defId];
      if (!def) return false;
      const fp = getBuildingFootprint(def, b.rotation ?? 0);
      for (let dx = -1; dx <= fp.width; dx++) {
        for (let dy = -1; dy <= fp.height; dy++) {
          const tk = `${b.gx + dx}:${b.gy + dy}`;
          if (waterTiles.has(tk)) return true;
        }
      }
      return pumpCenters.some(
        (p) => Math.abs(p.gx - b.gx) + Math.abs(p.gy - b.gy) <= 5
      );
    };

    let totalWaterGen = 0;
    let totalWaterDelivered = 0;
    let totalWaterDem = 0;
    let wConn = 0;
    let wDisc = 0;
    let wShortage = 0;

    for (const src of waterSources) totalWaterGen += getEffectiveWaterOutput(src);

    for (const b of state.buildings) {
      if (b.status === 'constructing') continue;
      const dem = getScaledWaterDemand(b);
      if (!b.enabled) {
        b.waterConnected = visitedWaterBuildings.has(b.id);
        b.waterSatisfaction = dem > 0 ? 0 : 1;
        b.waterReason = 'ok';
        continue;
      }

      if (!visitedWaterBuildings.has(b.id)) {
        b.waterConnected = false;
        b.waterNetworkId = 0;
        b.waterSatisfaction = dem > 0 ? 0 : 1;
        b.waterReason =
          dem > 0
            ? hasAnyWaterPipeNeighbor(b)
              ? 'disconnected_section_no_source'
              : 'not_connected_to_network'
            : 'ok';
        if (dem > 0) {
          totalWaterDem += dem;
          wDisc++;
        }
      } else {
        const netId = b.waterNetworkId ?? 0;
        const g = waterGenByNet.get(netId) ?? 0;
        const d = waterDemByNet.get(netId) ?? 0;
        const distCap = waterDistCapByNet.get(netId) ?? 999999;
        const effectiveCap = Math.min(g, distCap);
        const sat = d === 0 ? 1 : g <= 0 ? 0 : Math.min(1, effectiveCap / d);
        b.waterSatisfaction = sat;
        if (dem > 0) {
          totalWaterDem += dem;
          totalWaterDelivered += Math.round(dem * sat);
          wConn++;
          if (sat < 1) wShortage++;
        }
        if (sat >= 1 || dem === 0) {
          b.waterReason = 'ok';
        } else if (g <= 0) {
          b.waterReason = 'source_inactive';
        } else if (g > distCap && d > distCap) {
          b.waterReason = 'distribution_overloaded';
        } else {
          b.waterReason = 'insufficient_supply';
        }
      }
    }

    state.waterGenerated = totalWaterGen;
    state.waterDelivered = totalWaterDelivered;
    state.waterDemand = totalWaterDem;

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
