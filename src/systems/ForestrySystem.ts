import { BUILDINGS } from '../data/buildings.data';
import { FeatureType, isTreeFeature, TREE_SPECIES } from '../data/trees.data';
import type { ChunkManager } from '../core/ChunkManager';
import {
  BiomeId,
  ChunkData,
  TileFlag,
  TreeRegrowthEntry,
  TreeStage,
  WorldEngineState,
  ZoneId,
} from '../core/GameState';
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

/** Trees per growth stage, expressed in simulation ticks (= 1 in-game second at 1x). */
export const TREE_LIFECYCLE_TIMING = {
  /** Minimum idle time on cleared locked land before a seed may take root. */
  reseedDelayTicks: 70,
  /** Empty -> sapling. */
  saplingTicks: 45,
  /** Sapling -> young (medium tree). */
  youngTicks: 90,
  /** Young -> mature (harvestable). */
  matureTicks: 130,
  /** Extra delay after a harvest so a felled tile never instantly regrows. */
  harvestCooldownTicks: 55,
  /**
   * Hard ceiling of wild trees in the 7x7 density patch. The *effective* limit is
   * the biome's forest canopy target scaled onto the patch area: a jungle is far
   * denser than grassland. A single absolute cap (the old value was 13 for every
   * biome) meant a healthy jungle forest could never regrow a felled tile, because
   * the patch was always already "too dense". That is why harvested areas stalled.
   */
  maxWildTreesPerPatch: 49,
  /** Radius used for the density patch test. */
  densityPatchRadius: 3,
} as const;

/** Species preference tables so regrowth matches the local biome instead of always jungling. */
function pickRegrowthSpecies(biome: BiomeId, fallback: FeatureType): FeatureType {
  switch (biome) {
    case BiomeId.Forest:
      return [FeatureType.OakTree, FeatureType.PineTree, FeatureType.BirchTree, FeatureType.JungleHardwood][
        Math.abs(fallback) % 4
      ];
    case BiomeId.Jungle:
      return [FeatureType.JungleHardwood, FeatureType.AncientMahogany, FeatureType.BambooCluster][
        Math.abs(fallback) % 3
      ];
    case BiomeId.Fertile:
      return [FeatureType.FruitTree, FeatureType.TropicalPalm, FeatureType.OakTree][Math.abs(fallback) % 3];
    case BiomeId.Swamp:
      return FeatureType.CypressTree;
    case BiomeId.Desert:
      return FeatureType.AcaciaTree;
    case BiomeId.Mountain:
      return FeatureType.PineTree;
    case BiomeId.Grassland:
      return [FeatureType.OakTree, FeatureType.BirchTree, FeatureType.AcaciaTree][Math.abs(fallback) % 3];
    case BiomeId.Beach:
      return FeatureType.TropicalPalm;
    default:
      return FeatureType.JungleHardwood;
  }
}

/**
 * ForestrySystem owns the tree lifecycle and manual harvesting.
 *
 * Growth invariants (enforced here, not in the renderer):
 *  1. Owned (unlocked) land NEVER auto-regrows trees. Only explicit plant actions
 *     (player replant or a Forester Hut) may place a sapling there.
 *  2. Only locked/unowned tiles participate in natural regeneration.
 *  3. Growth always moves empty -> sapling -> young -> mature using timers that are
 *     persisted (`featureStage` + `treeRegrowthQueue`) so saves resume correctly.
 */
export class ForestrySystem {
  /**
   * Schedules natural regrowth for a felled tree.
   * Owned tiles are ignored entirely unless `force` is used by an explicit
   * management building (never by harvesting).
   */
  public scheduleTreeRegrowth(
    gx: number,
    gy: number,
    ft: FeatureType,
    state: WorldEngineState,
    options?: { force?: boolean; harvested?: boolean }
  ): void {
    const species = TREE_SPECIES[ft];
    if (!species || species.woodYield <= 0) return;
    if (ft === FeatureType.Sapling || ft === FeatureType.StoneOutcrop || ft === FeatureType.AncientRuin) return;

    state.treeRegrowthQueue ??= [];
    const existingIdx = state.treeRegrowthQueue.findIndex((e) => e.gx === gx && e.gy === gy);
    const harvested = options?.harvested !== false;
    const cooldown = harvested ? TREE_LIFECYCLE_TIMING.harvestCooldownTicks : 0;
    const entry: TreeRegrowthEntry = {
      gx,
      gy,
      species: ft,
      stage: 'empty',
      stageStartedTick: state.tick,
      harvested,
      saplingAtTick: state.tick + cooldown + TREE_LIFECYCLE_TIMING.saplingTicks,
      readyAtTick:
        state.tick +
        cooldown +
        TREE_LIFECYCLE_TIMING.saplingTicks +
        TREE_LIFECYCLE_TIMING.youngTicks +
        TREE_LIFECYCLE_TIMING.matureTicks,
    };
    if (existingIdx >= 0) {
      state.treeRegrowthQueue[existingIdx] = entry;
    } else {
      state.treeRegrowthQueue.push(entry);
    }
  }

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
    if (chunk.featureStage) chunk.featureStage[index] = TreeStage.Empty;
    // Owned land never reforests automatically: only locked tiles are queued.
    if (!chunks.isUnlocked(gx, gy)) {
      this.scheduleTreeRegrowth(gx, gy, ft, state, { harvested: true });
    }

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
    if (chunk.featureStage) chunk.featureStage[index] = TreeStage.Sapling;
    chunks.markChunkModified(cx, cy);
    return true;
  }

  /**
   * True when a locked tile may host a new wild tree: empty ground, no road,
   * no building, valid biome, and not above the local density ceiling.
   */
  private canSeedWildTree(cx: number, cy: number, chunks: ChunkManager, state: WorldEngineState): boolean {
    const chunk = chunks.getOrCreateChunk(cx, cy);
    const len = CHUNK_SIZE * CHUNK_SIZE;
    let trees = 0;
    for (let i = 0; i < len; i++) {
      if (isTreeFeature(chunk.featureType[i] as FeatureType)) trees++;
    }
    void state;
    // Chunk-wide density ceiling keeps regeneration from saturating whole regions.
    return trees < Math.floor(len * 0.55);
  }

  /**
   * Counts wild trees in the surrounding patch (used for the density rule so we
   * never turn locked land into a solid wall of trees).
   */
  /**
   * Canopy target for a 7x7 patch, in trees, per biome. Derived from how densely
   * the world generator populates each biome so regrowth restores the original
   * look instead of an arbitrary constant.
   */
  private static patchCanopyTarget(biome: BiomeId): number {
    switch (biome) {
      case BiomeId.Jungle:
        return 34;
      case BiomeId.Forest:
        return 30;
      case BiomeId.Fertile:
        return 22;
      case BiomeId.Swamp:
        return 20;
      case BiomeId.Grassland:
        return 14;
      case BiomeId.Beach:
        return 5;
      case BiomeId.Desert:
      case BiomeId.Mountain:
        return 0;
      default:
        return 10;
    }
  }

  private patchTreeCount(gx: number, gy: number, chunks: ChunkManager): number {
    const r = TREE_LIFECYCLE_TIMING.densityPatchRadius;
    let count = 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const { chunk, index } = chunks.getTile(gx + dx, gy + dy);
        if (isTreeFeature(chunk.featureType[index] as FeatureType)) count++;
      }
    }
    return count;
  }

  private isValidGrowthTile(
    gx: number,
    gy: number,
    chunks: ChunkManager
  ): { ok: boolean; chunk?: ChunkData; index?: number } {
    const { cx, cy, index } = gridToChunk(gx, gy);
    const chunk = chunks.getOrCreateChunk(cx, cy);
    const biome = chunk.biomeId[index] as BiomeId;
    if (chunks.isWaterBiome(biome)) return { ok: false };
    if (biome === BiomeId.Desert || biome === BiomeId.Mountain) return { ok: false };
    if (chunk.buildingRef[index] !== -1) return { ok: false };
    if (chunk.roadType[index] !== 0) return { ok: false };
    return { ok: true, chunk, index };
  }

  private queueEntryFor(gx: number, gy: number, state: WorldEngineState): TreeRegrowthEntry | undefined {
    return state.treeRegrowthQueue?.find((e) => e.gx === gx && e.gy === gy);
  }

  /**
   * Advances the tree lifecycle. Runs every 5 ticks so the cost stays negligible
   * even on very large maps.
   */
  public tickRegrowth(chunks: ChunkManager, state: WorldEngineState, springBoost: number): void {
    if (state.tick % 5 !== 0) return;

    let policyBoost = 1.0;
    if (state.activePolicies?.includes('timber_stewards')) policyBoost *= 1.35;
    if (state.activePolicies?.includes('green_charter')) policyBoost *= 1.6;
    const growthSpeed = Math.max(0.25, springBoost * policyBoost);

    state.treeRegrowthQueue ??= [];

    // ---- 1. Advance every queued regeneration entry through its stages --------
    for (let i = state.treeRegrowthQueue.length - 1; i >= 0; i--) {
      const entry = state.treeRegrowthQueue[i];
      const valid = this.isValidGrowthTile(entry.gx, entry.gy, chunks);
      if (!valid.ok || !valid.chunk || valid.index === undefined) {
        state.treeRegrowthQueue.splice(i, 1);
        continue;
      }
      const chunk = valid.chunk;
      const index = valid.index;
      const unlocked = (chunk.flags[index] & TileFlag.Unlocked) !== 0;

      // Invariant: owned land never regrows on its own. Drop the entry entirely.
      if (unlocked) {
        state.treeRegrowthQueue.splice(i, 1);
        continue;
      }

      const ft = chunk.featureType[index] as FeatureType;
      const current = (chunk.featureStage?.[index] ?? 0) as TreeStage;

      // Species the entry should end up as.
      const speciesType = (TREE_SPECIES[entry.species] ? entry.species : pickRegrowthSpecies(
        chunk.biomeId[index] as BiomeId,
        entry.species
      )) as FeatureType;

      // A foreign tree blocking the tile means someone else already grew here.
      if (isTreeFeature(ft) && ft !== FeatureType.Sapling && current === TreeStage.Mature) {
        state.treeRegrowthQueue.splice(i, 1);
        continue;
      }

      const elapsed = state.tick - (entry.stageStartedTick ?? state.tick);
      const effectiveElapsed = elapsed * growthSpeed;

      if (current === TreeStage.Empty || ft === FeatureType.None) {
        // Wait out the reseed delay, then root a sapling (density permitting).
        if (effectiveElapsed < TREE_LIFECYCLE_TIMING.saplingTicks) continue;
        // Density rule: regrow up to the biome's canopy target, never beyond the
        // hard ceiling. Previously any patch above a flat 13 was frozen forever.
        const biomeNow = chunk.biomeId[index] as BiomeId;
        const canopyCap = Math.min(
          TREE_LIFECYCLE_TIMING.maxWildTreesPerPatch,
          ForestrySystem.patchCanopyTarget(biomeNow)
        );
        if (this.patchTreeCount(entry.gx, entry.gy, chunks) >= canopyCap) {
          // At capacity: hold the entry (it will grow once nearby trees are felled).
          continue;
        }
        chunk.featureType[index] = FeatureType.Sapling;
        chunk.featureHp[index] = TREE_SPECIES[FeatureType.Sapling]?.maxHp ?? 15;
        if (!chunk.featureStage) chunk.featureStage = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
        chunk.featureStage[index] = TreeStage.Sapling;
        entry.stage = 'sapling';
        entry.stageStartedTick = state.tick;
        entry.saplingAtTick = Math.min(entry.saplingAtTick, state.tick);
        chunks.markChunkModified(chunk.cx, chunk.cy);
        continue;
      }

      if (current === TreeStage.Sapling) {
        if (effectiveElapsed < TREE_LIFECYCLE_TIMING.youngTicks) continue;
        chunk.featureType[index] = speciesType;
        chunk.featureHp[index] = Math.round((TREE_SPECIES[speciesType]?.maxHp ?? 40) * 0.6);
        chunk.featureStage[index] = TreeStage.Young;
        entry.stage = 'young';
        entry.stageStartedTick = state.tick;
        chunks.markChunkModified(chunk.cx, chunk.cy);
        continue;
      }

      if (current === TreeStage.Young) {
        if (effectiveElapsed < TREE_LIFECYCLE_TIMING.matureTicks) continue;
        chunk.featureType[index] = speciesType;
        chunk.featureHp[index] = TREE_SPECIES[speciesType]?.maxHp ?? 40;
        chunk.featureStage[index] = TreeStage.Mature;
        chunks.markChunkModified(chunk.cx, chunk.cy);
        // Lifecycle finished: the tile is now a normal harvestable tree.
        state.treeRegrowthQueue.splice(i, 1);
        continue;
      }

      // Already mature: nothing left to do.
      state.treeRegrowthQueue.splice(i, 1);
    }

    // ---- 2. Seed brand new wild trees on locked land -------------------------
    this.seedWildTrees(chunks, state, growthSpeed);

    // ---- 3. Normalise explicit player-planted saplings on owned land ---------
    for (const chunk of chunks.getAllLoadedChunks()) {
      if (!chunk.isModified) continue;
      for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++) {
        if (chunk.featureType[i] !== FeatureType.Sapling) continue;
        const { gx, gy } = chunkToGrid(chunk.cx, chunk.cy, i % CHUNK_SIZE, Math.floor(i / CHUNK_SIZE));
        if (this.queueEntryFor(gx, gy, state)) continue;
        const stage = (chunk.featureStage?.[i] ?? TreeStage.Sapling) as TreeStage;
        if (stage !== TreeStage.Sapling) {
          if (!chunk.featureStage) chunk.featureStage = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
          chunk.featureStage[i] = TreeStage.Sapling;
        }
      }
    }
  }

  /**
   * Natural reseeding pass. Only locked tiles are considered, and the rate is
   * deliberately small so forests grow back gradually instead of instantly.
   */
  private seedWildTrees(chunks: ChunkManager, state: WorldEngineState, growthSpeed: number): void {
    state.treeRegrowthQueue ??= [];
    const queued = new Set(state.treeRegrowthQueue.map((e) => `${e.gx}:${e.gy}`));

    // Work only on chunks the player has actually "seen" (modified) and only on
    // every 4th regrowth pass to spread CPU cost.
    if (state.tick % 20 !== 0) return;

    const candidates: Array<{ gx: number; gy: number; biome: BiomeId; seed: number }> = [];
    for (const chunk of chunks.getAllLoadedChunks()) {
      if (!chunk.isModified) continue;
      if (!this.canSeedWildTree(chunk.cx, chunk.cy, chunks, state)) continue;
      for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++) {
        if ((chunk.flags[i] & TileFlag.Unlocked) !== 0) continue; // owned land: never
        if (chunk.featureType[i] !== FeatureType.None) continue;
        if (chunk.buildingRef[i] !== -1 || chunk.roadType[i] !== 0) continue;
        const biome = chunk.biomeId[i] as BiomeId;
        if (chunks.isWaterBiome(biome) || biome === BiomeId.Desert || biome === BiomeId.Mountain) continue;
        const { gx, gy } = chunkToGrid(chunk.cx, chunk.cy, i % CHUNK_SIZE, Math.floor(i / CHUNK_SIZE));
        const key = `${gx}:${gy}`;
        if (queued.has(key)) continue;
        // Deterministic per-tile roll, biased by growth speed and season.
        const target = ForestrySystem.patchCanopyTarget(biome);
        if (target <= 0) continue;
        const canopy = this.patchTreeCount(gx, gy, chunks);
        if (canopy >= target) continue;
        // Seed faster where the forest is thin, slower near full canopy. This keeps
        // the overall density stable instead of a flat per-tile dice roll.
        const pressure = 1 - canopy / target;
        const roll = (Math.abs(Math.sin(gx * 12.9898 + gy * 78.233 + chunk.cx * 3.7) * 43758.5453) % 1);
        if (roll > 0.06 * growthSpeed * (0.35 + pressure * 1.65)) continue;
        candidates.push({ gx, gy, biome, seed: i });
      }
    }

    // Cap how many brand-new trees may appear per pass to avoid visible bursts.
    const cap = Math.max(2, Math.round(3 * growthSpeed));
    for (const c of candidates.slice(0, cap)) {
      if (this.patchTreeCount(c.gx, c.gy, chunks) > TREE_LIFECYCLE_TIMING.maxWildTreesPerPatch) continue;
      const species = pickRegrowthSpecies(c.biome, c.seed);
      state.treeRegrowthQueue.push({
        gx: c.gx,
        gy: c.gy,
        species,
        stage: 'empty',
        stageStartedTick: state.tick - TREE_LIFECYCLE_TIMING.saplingTicks + 10,
        harvested: false,
        saplingAtTick: state.tick + 10,
        readyAtTick:
          state.tick +
          10 +
          TREE_LIFECYCLE_TIMING.youngTicks +
          TREE_LIFECYCLE_TIMING.matureTicks,
      });
    }
  }

  /**
   * Forester Huts actively plant saplings on owned land around themselves.
   * This is an explicit gameplay system (not automatic regeneration), so it is
   * allowed to place saplings on owned tiles.
   */
  public plantAroundForesterHuts(state: WorldEngineState, chunks: ChunkManager): void {
    if (state.tick % 20 !== 0) return;
    for (const b of state.buildings) {
      if (b.defId !== 'forester_hut' || b.status !== 'active') continue;
      const def = BUILDINGS[b.defId];
      if (!def) continue;
      const rx = b.gx + (((state.tick / 20 + b.id) % 7) - 3);
      const ry = b.gy + ((((state.tick / 20) * 3 + b.id) % 7) - 3);
      const { chunk, index } = chunks.getTile(rx, ry);
      const isUnlocked = (chunk.flags[index] & TileFlag.Unlocked) !== 0;
      if (
        isUnlocked &&
        chunk.featureType[index] === FeatureType.None &&
        chunk.buildingRef[index] === -1 &&
        chunk.roadType[index] === 0
      ) {
        const { gx, gy } = chunkToGrid(chunk.cx, chunk.cy, index % CHUNK_SIZE, Math.floor(index / CHUNK_SIZE));
        this.replantTile(gx, gy, chunks);
        // Explicitly planted saplings grow on their own schedule too.
        chunks.setFeatureStage(gx, gy, TreeStage.Sapling);
        state.treeRegrowthQueue ??= [];
        if (!this.queueEntryFor(gx, gy, state)) {
          state.treeRegrowthQueue.push({
            gx,
            gy,
            species: FeatureType.OakTree,
            stage: 'sapling',
            stageStartedTick: state.tick,
            harvested: false,
            saplingAtTick: state.tick,
            readyAtTick: state.tick + TREE_LIFECYCLE_TIMING.youngTicks + TREE_LIFECYCLE_TIMING.matureTicks,
          });
        }
      }
    }
  }

  /** Trees that the forestry fleet may harvest: mature, on locked (or permitted) land. */
  public isHarvestableMatureTree(gx: number, gy: number, chunks: ChunkManager, allowOwned: boolean): boolean {
    const { chunk, index } = chunks.getTile(gx, gy);
    const ft = chunk.featureType[index] as FeatureType;
    if (!isTreeFeature(ft)) return false;
    const unlocked = (chunk.flags[index] & TileFlag.Unlocked) !== 0;
    if (unlocked && !allowOwned) return false;
    const stage = (chunk.featureStage?.[index] ?? TreeStage.Mature) as TreeStage;
    return stage === TreeStage.Mature;
  }

  /** Forestry Zone tiles get a small regrowth bonus (zone-based, not global). */
  public hasForestryZone(gx: number, gy: number, chunks: ChunkManager): boolean {
    return chunks.getTileZone(gx, gy) === ZoneId.Forestry;
  }
}
