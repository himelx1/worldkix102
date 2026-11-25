import { BUILDINGS } from '../data/buildings.data';
import { FeatureType, TREE_SPECIES } from '../data/trees.data';
import type { ChunkManager } from '../core/ChunkManager';
import { BiomeId, TileFlag, WorldEngineState } from '../core/GameState';
import { CHUNK_SIZE, chunkToGrid, gridToChunk } from '../core/IsoMath';
import { ResourceSystem } from './ResourceSystem';

export interface ChopOutcome {
  hit: boolean;
  cleared: boolean;
  woodGained: number;
  bonusName?: string;
  bonusAmount?: number;
  coinsGained: number;
  xpGained: number;
}

export class ForestrySystem {
  public chopTile(
    gx: number,
    gy: number,
    damage: number,
    chunks: ChunkManager,
    state: WorldEngineState
  ): ChopOutcome {
    if (!chunks.isUnlocked(gx, gy)) {
      return { hit: false, cleared: false, woodGained: 0, coinsGained: 0, xpGained: 0 };
    }

    const { cx, cy, index } = gridToChunk(gx, gy);
    const chunk = chunks.getOrCreateChunk(cx, cy);
    const ft = chunk.featureType[index] as FeatureType;
    if (ft === FeatureType.None) {
      return { hit: false, cleared: false, woodGained: 0, coinsGained: 0, xpGained: 0 };
    }

    const species = TREE_SPECIES[ft];
    if (!species) {
      return { hit: false, cleared: false, woodGained: 0, coinsGained: 0, xpGained: 0 };
    }

    const nextHp = Math.max(0, chunk.featureHp[index] - Math.round(damage));
    chunk.featureHp[index] = nextHp;
    chunks.markChunkModified(cx, cy);

    if (nextHp > 0) {
      return { hit: true, cleared: false, woodGained: 0, coinsGained: 0, xpGained: 0 };
    }

    // Tree or boulder cleared!
    chunk.featureType[index] = FeatureType.None;
    chunk.featureHp[index] = 0;

    let woodGained = 0;
    const timberBoost = state.activePolicies?.includes('timber_stewards') ? 1.35 : 1.0;
    if (species.woodYield > 0) {
      const yieldAmt = Math.round(species.woodYield * timberBoost);
      woodGained = ResourceSystem.addClamped(state, 'wood', yieldAmt);
    }

    let bonusName: string | undefined;
    let bonusAmount = 0;
    if (species.bonusResource && species.bonusAmount) {
      const roll = ((gx * 73856093) ^ (gy * 19349663) ^ state.tick) & 255;
      if (roll / 255 <= (species.bonusChance ?? 1)) {
        const amt =
          species.bonusResource === 'bamboo'
            ? Math.round(species.bonusAmount * timberBoost)
            : species.bonusAmount;
        bonusAmount = ResourceSystem.addClamped(state, species.bonusResource, amt);
        bonusName = species.bonusResource;
      }
    }

    if (ft === FeatureType.AncientRuin) {
      state.researchPoints += 8;
      state.stats.ruinsExplored += 1;
    }

    state.coins += species.coinYield;
    state.stats.totalCoinsEarned += species.coinYield;
    state.stats.treesCut += 1;

    return {
      hit: true,
      cleared: true,
      woodGained,
      bonusName,
      bonusAmount,
      coinsGained: species.coinYield,
      xpGained: species.xpYield,
    };
  }

  public exploreRuin(
    gx: number,
    gy: number,
    chunks: ChunkManager,
    state: WorldEngineState
  ): { ok: boolean; reason?: string; coins: number; rp: number; stone: number; wood: number; xp: number } {
    if (!chunks.isUnlocked(gx, gy)) {
      return { ok: false, reason: 'Unlock this tile first to explore the ruin', coins: 0, rp: 0, stone: 0, wood: 0, xp: 0 };
    }
    const { cx, cy, index } = gridToChunk(gx, gy);
    const chunk = chunks.getOrCreateChunk(cx, cy);
    if (chunk.featureType[index] !== FeatureType.AncientRuin) {
      return { ok: false, reason: 'No Ancient Ruin on this tile', coins: 0, rp: 0, stone: 0, wood: 0, xp: 0 };
    }

    chunk.featureType[index] = FeatureType.None;
    chunk.featureHp[index] = 0;
    chunks.markChunkModified(cx, cy);

    const coins = 140 + (Math.abs(gx * 37 + gy * 53 + state.tick) % 80);
    const rp = 12;
    const stone = ResourceSystem.addClamped(state, 'stone', 10);
    const wood = ResourceSystem.addClamped(state, 'wood', 6);
    const xp = 45;

    state.coins += coins;
    state.stats.totalCoinsEarned += coins;
    state.researchPoints += rp;
    state.stats.ruinsExplored += 1;

    return { ok: true, coins, rp, stone, wood, xp };
  }

  public replantTile(gx: number, gy: number, chunks: ChunkManager): boolean {
    if (!chunks.isUnlocked(gx, gy)) return false;
    const { cx, cy, index } = gridToChunk(gx, gy);
    const chunk = chunks.getOrCreateChunk(cx, cy);
    const biome = chunk.biomeId[index] as BiomeId;
    if (chunks.isWaterBiome(biome) || biome === BiomeId.Desert || biome === BiomeId.Mountain) return false;
    if (chunk.featureType[index] !== FeatureType.None) return false;
    if (chunk.buildingRef[index] !== -1 || chunk.roadType[index] !== 0) return false;

    chunk.featureType[index] = FeatureType.Sapling;
    chunk.featureHp[index] = 15;
    chunk.flags[index] |= TileFlag.ReforestZone;
    chunks.markChunkModified(cx, cy);
    return true;
  }

  public tickRegrowth(chunks: ChunkManager, state: WorldEngineState, springBoost: number): void {
    // Only grow saplings every 5 ticks to keep CPU negligible
    if (state.tick % 5 !== 0) return;

    let policyBoost = 1.0;
    if (state.activePolicies?.includes('timber_stewards')) policyBoost *= 1.5;
    if (state.activePolicies?.includes('green_charter')) policyBoost *= 2.0;

    // Mature saplings and allow Forester Huts to replant nearby empty forest tiles
    for (const chunk of chunks.getAllLoadedChunks()) {
      if (!chunk.isModified) continue;
      for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++) {
        if (chunk.featureType[i] === FeatureType.Sapling) {
          const growChance = 0.08 * springBoost * policyBoost;
          if (((state.tick + i * 17) % 100) / 100 < growChance) {
            chunk.featureType[i] = FeatureType.JungleHardwood;
            chunk.featureHp[i] = TREE_SPECIES[FeatureType.JungleHardwood].maxHp;
            chunks.markChunkModified(chunk.cx, chunk.cy);
          }
        }
      }
    }

    // Forester Huts gently plant saplings around themselves every 20 ticks
    if (state.tick % 20 === 0) {
      for (const b of state.buildings) {
        if (b.defId !== 'forester_hut' || b.status !== 'active') continue;
        const def = BUILDINGS[b.defId];
        if (!def) continue;
        const rx = b.gx + ((state.tick / 20 + b.id) % 7) - 3;
        const ry = b.gy + ((state.tick / 20 * 3 + b.id) % 7) - 3;
        const { chunk, index } = chunks.getTile(rx, ry);
        const isUnlocked = (chunk.flags[index] & TileFlag.Unlocked) !== 0;
        if (isUnlocked && chunk.featureType[index] === FeatureType.None && chunk.buildingRef[index] === -1 && chunk.roadType[index] === 0) {
          const { gx, gy } = chunkToGrid(chunk.cx, chunk.cy, index % CHUNK_SIZE, Math.floor(index / CHUNK_SIZE));
          this.replantTile(gx, gy, chunks);
        }
      }
    }
  }
}
