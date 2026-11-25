import React, { useState } from 'react';
import { Eye, Grid, Layers, Paintbrush, Trees, Waves } from 'lucide-react';
import { formatCompactNumber } from '../../core/Formatters';
import { ZONE_META, ZoneType } from '../../core/GameState';
import type { TerrainBrushKind } from '../../engine/WorldScene';
import { GameController, GameSnapshot } from '../bridge/GameController';
import { SheetContainer } from './SheetContainer';

const BRUSH_OPTIONS: Array<{ id: TerrainBrushKind; label: string }> = [
  { id: 'unlock', label: 'Unlock Tiles' },
  { id: 'zone', label: 'District Zone' },
  { id: 'logging_permit', label: 'Logging Permit' },
  { id: 'clear_permit', label: 'Clear Permit' },
  { id: 'water', label: 'Paint Water' },
  { id: 'land', label: 'Reclaim Land' },
];

export const LandUnlockSheet: React.FC<{ snap: GameSnapshot }> = ({ snap }) => {
  const { state } = snap;
  const chunks = GameController.engine.chunks;
  const viewCenter = GameController.getViewportCenterGrid();

  const [startGx, setStartGx] = useState<number>(() => viewCenter.gx - 4);
  const [startGy, setStartGy] = useState<number>(() => viewCenter.gy - 4);
  const [rectW, setRectW] = useState<number>(8);
  const [rectH, setRectH] = useState<number>(8);
  const [rectPreviewOn, setRectPreviewOn] = useState<boolean>(false);

  const [brushKind, setBrushKind] = useState<TerrainBrushKind>('zone');
  const [brushRadius, setBrushRadius] = useState<number>(1);
  const [brushZone, setBrushZone] = useState<ZoneType>('residential');

  const rectQuote = chunks.getRectangleUnlockQuote(startGx, startGy, rectW, rectH);
  const permittedCount = state.loggingStats?.permittedForestTiles ?? chunks.countLoggingPermittedTiles();

  let targetChunk: { cx: number; cy: number; cost: number; lockedCount: number } | null = null;
  for (let cy = -2; cy <= 2 && !targetChunk; cy++) {
    for (let cx = -2; cx <= 2 && !targetChunk; cx++) {
      if (chunks.canUnlockChunk(cx, cy)) {
        const quote = chunks.getChunkUnlockCost(cx, cy);
        if (quote.lockedCount > 0) {
          targetChunk = { cx, cy, cost: quote.cost, lockedCount: quote.lockedCount };
        }
      }
    }
  }

  const updatePreviewIfActive = (sx: number, sy: number, w: number, h: number, active: boolean) => {
    if (active) {
      GameController.setRectPreview({ startGx: sx, startGy: sy, width: w, height: h });
    } else {
      GameController.setRectPreview(null);
    }
  };

  return (
    <SheetContainer
      title="Expand & Sculpt Territory"
      subtitle={`Unlocked Tiles: ${state.stats.unlockedTiles} · Coins: ${formatCompactNumber(state.coins)}`}
    >
      <div className="space-y-3.5 text-sm text-stone-200 min-w-0">
        {/* True Land Mode & Persistent Zone Borders */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() =>
              GameController.dispatch({
                type: 'TOGGLE_LAND_MODE',
                enabled: !state.landModeActive,
              })
            }
            className={`min-h-[46px] px-3.5 rounded-xl border font-bold text-xs flex items-center justify-between gap-2 transition-colors ${
              state.landModeActive
                ? 'bg-amber-400 border-amber-300 text-stone-950'
                : 'bg-[#0b1f16] border-emerald-700/60 text-stone-100 hover:border-amber-400/60'
            }`}
          >
            <span className="flex items-center gap-1.5 truncate">
              <Eye className="w-4 h-4 shrink-0" />
              True Land Mode
            </span>
            <span className="text-[11px] uppercase shrink-0">
              {state.landModeActive ? 'ON' : 'OFF'}
            </span>
          </button>

          <button
            type="button"
            onClick={() =>
              GameController.dispatch({
                type: 'TOGGLE_ZONE_BORDERS',
                enabled: !state.showZoneBorders,
              })
            }
            className={`min-h-[46px] px-3.5 rounded-xl border font-bold text-xs flex items-center justify-between gap-2 transition-colors ${
              state.showZoneBorders
                ? 'bg-emerald-500 border-emerald-400 text-stone-950'
                : 'bg-[#0b1f16] border-emerald-700/60 text-stone-100 hover:border-emerald-400/60'
            }`}
          >
            <span className="flex items-center gap-1.5 truncate">
              <Layers className="w-4 h-4 shrink-0" />
              Show Zone Borders
            </span>
            <span className="text-[11px] uppercase shrink-0">
              {state.showZoneBorders ? 'ON' : 'OFF'}
            </span>
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2 text-xs tabular-nums">
          <div className="p-3 rounded-2xl bg-gradient-to-b from-[#132b1f] to-[#0a1a12] border border-emerald-700/50">
            <div className="text-stone-400">Territory</div>
            <div className="text-lg font-extrabold text-stone-100 mt-0.5">
              {state.stats.unlockedTiles}
            </div>
          </div>
          <div className="p-3 rounded-2xl bg-gradient-to-b from-[#132b1f] to-[#0a1a12] border border-emerald-700/50">
            <div className="text-stone-400">Trees Cut</div>
            <div className="text-lg font-extrabold text-lime-300 mt-0.5">
              {state.stats.treesCut}
            </div>
          </div>
          <div className="p-3 rounded-2xl bg-gradient-to-b from-[#132b1f] to-[#0a1a12] border border-emerald-700/50">
            <div className="text-stone-400 flex items-center gap-1">
              <Trees className="w-3 h-3 text-emerald-400" /> Permits
            </div>
            <div className="text-lg font-extrabold text-emerald-300 mt-0.5">
              {permittedCount}
            </div>
          </div>
        </div>

        {/* Quick Unlock Tools */}
        <div className="flex flex-col sm:flex-row gap-2.5">
          <button
            type="button"
            onClick={() => {
              GameController.setTool({ mode: 'land_unlock' });
              GameController.setActiveSheet('none');
            }}
            className="flex-1 min-h-[46px] px-4 rounded-xl bg-gradient-to-b from-amber-400 to-amber-500 text-stone-950 font-bold text-xs sm:text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_3px_0_#92400e] active:translate-y-[2px]"
          >
            Tap Border Blocks on Map
          </button>
          <button
            type="button"
            onClick={() => {
              const c = GameController.getViewportCenterGrid();
              GameController.dispatch({
                type: 'UNLOCK_BATCH_FRONTIER',
                centerGx: c.gx,
                centerGy: c.gy,
                radius: 6,
              });
            }}
            className="flex-1 min-h-[46px] px-4 rounded-xl bg-gradient-to-b from-emerald-600 to-emerald-700 text-white font-bold text-xs sm:text-sm border border-emerald-500/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_3px_0_#064e3b] active:translate-y-[2px]"
          >
            Expand Nearby Ring
          </button>
        </div>

        {targetChunk ? (
          <button
            type="button"
            onClick={() =>
              GameController.dispatch({
                type: 'UNLOCK_CHUNK',
                cx: targetChunk!.cx,
                cy: targetChunk!.cy,
              })
            }
            className="w-full min-h-[46px] px-4 rounded-xl bg-[#0d2433] border border-sky-600/60 text-sky-100 font-bold text-xs tabular-nums flex items-center justify-between gap-2"
          >
            <span className="truncate">
              Unlock Chunk ({targetChunk.cx}, {targetChunk.cy}) · {targetChunk.lockedCount} tiles
            </span>
            <span className="text-amber-300 shrink-0">{formatCompactNumber(targetChunk.cost)}C (-20%)</span>
          </button>
        ) : null}

        {/* Rectangular Land Purchase with Live Quote & Preview */}
        <div className="p-3.5 rounded-2xl bg-gradient-to-b from-[#13291e] to-[#08150f] border border-emerald-700/55 space-y-2.5 tabular-nums">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-bold text-amber-300">
              <Grid className="w-4 h-4 shrink-0" />
              <span>Rectangular Land Purchase</span>
            </div>
            <button
              type="button"
              onClick={() => {
                const c = GameController.getViewportCenterGrid();
                const nx = c.gx - Math.floor(rectW / 2);
                const ny = c.gy - Math.floor(rectH / 2);
                setStartGx(nx);
                setStartGy(ny);
                updatePreviewIfActive(nx, ny, rectW, rectH, rectPreviewOn);
              }}
              className="min-h-[34px] px-2.5 rounded-lg bg-[#0d2433] border border-sky-600/50 text-sky-200 text-[11px] font-semibold"
            >
              Center on View
            </button>
          </div>

          <div className="grid grid-cols-4 gap-1.5 text-[11px]">
            <label className="text-stone-400">
              Start X
              <input
                type="number"
                value={startGx}
                onChange={(e) => {
                  const v = Math.trunc(Number(e.target.value) || 0);
                  setStartGx(v);
                  updatePreviewIfActive(v, startGy, rectW, rectH, rectPreviewOn);
                }}
                className="mt-0.5 w-full min-h-[40px] px-2 rounded-lg bg-[#06120c] border border-emerald-800/70 text-stone-100 font-bold"
              />
            </label>
            <label className="text-stone-400">
              Start Y
              <input
                type="number"
                value={startGy}
                onChange={(e) => {
                  const v = Math.trunc(Number(e.target.value) || 0);
                  setStartGy(v);
                  updatePreviewIfActive(startGx, v, rectW, rectH, rectPreviewOn);
                }}
                className="mt-0.5 w-full min-h-[40px] px-2 rounded-lg bg-[#06120c] border border-emerald-800/70 text-stone-100 font-bold"
              />
            </label>
            <label className="text-stone-400">
              Width
              <input
                type="number"
                min={1}
                max={48}
                value={rectW}
                onChange={(e) => {
                  const v = Math.max(1, Math.min(48, Math.trunc(Number(e.target.value) || 1)));
                  setRectW(v);
                  updatePreviewIfActive(startGx, startGy, v, rectH, rectPreviewOn);
                }}
                className="mt-0.5 w-full min-h-[40px] px-2 rounded-lg bg-[#06120c] border border-emerald-800/70 text-stone-100 font-bold"
              />
            </label>
            <label className="text-stone-400">
              Height
              <input
                type="number"
                min={1}
                max={48}
                value={rectH}
                onChange={(e) => {
                  const v = Math.max(1, Math.min(48, Math.trunc(Number(e.target.value) || 1)));
                  setRectH(v);
                  updatePreviewIfActive(startGx, startGy, rectW, v, rectPreviewOn);
                }}
                className="mt-0.5 w-full min-h-[40px] px-2 rounded-lg bg-[#06120c] border border-emerald-800/70 text-stone-100 font-bold"
              />
            </label>
          </div>

          <div className="p-2.5 rounded-xl bg-[#07150e] border border-emerald-900/60 text-xs flex items-center justify-between gap-2">
            {rectQuote.valid ? (
              <>
                <span className="text-stone-300">
                  Buy <strong className="text-emerald-300">{rectQuote.toUnlockCount}</strong> locked tiles
                  {rectQuote.unlockedAlready > 0 ? ` (${rectQuote.unlockedAlready} owned)` : ''}
                </span>
                <span className="font-bold text-amber-300 shrink-0">
                  {formatCompactNumber(rectQuote.totalCost)}C
                </span>
              </>
            ) : (
              <span className="text-amber-300 text-[11px]">{rectQuote.reason}</span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                const next = !rectPreviewOn;
                setRectPreviewOn(next);
                updatePreviewIfActive(startGx, startGy, rectW, rectH, next);
              }}
              className={`min-h-[44px] px-3 rounded-xl font-bold text-xs border ${
                rectPreviewOn
                  ? 'bg-sky-500 border-sky-400 text-stone-950'
                  : 'bg-[#0b1f16] border-sky-700/60 text-sky-200'
              }`}
            >
              {rectPreviewOn ? 'Hide Map Preview' : 'Preview on Map'}
            </button>
            <button
              type="button"
              disabled={!rectQuote.valid || state.coins < rectQuote.totalCost}
              onClick={() => {
                const ok = GameController.dispatch({
                  type: 'UNLOCK_RECTANGLE',
                  startGx,
                  startGy,
                  width: rectW,
                  height: rectH,
                });
                if (ok) {
                  setRectPreviewOn(false);
                  GameController.setRectPreview(null);
                }
              }}
              className="min-h-[44px] px-3 rounded-xl bg-gradient-to-b from-amber-400 to-amber-500 disabled:from-stone-800 disabled:to-stone-800 disabled:text-stone-500 text-stone-950 font-bold text-xs"
            >
              {rectQuote.valid ? `Confirm Purchase (${formatCompactNumber(rectQuote.totalCost)}C)` : 'Unavailable'}
            </button>
          </div>
        </div>

        {/* Terrain, District Zone & Logging Permit Brushes */}
        <div className="p-3.5 rounded-2xl bg-gradient-to-b from-[#0d2433] to-[#081722] border border-sky-700/55 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-bold text-sky-200">
              <Paintbrush className="w-4 h-4 text-sky-300 shrink-0" />
              <span>Terrain, District &amp; Logging Brushes</span>
            </div>
            <div className="flex items-center gap-1">
              {[0, 1, 2].map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setBrushRadius(r)}
                  className={`min-h-[32px] px-2 rounded-lg text-[11px] font-bold ${
                    brushRadius === r
                      ? 'bg-amber-400 text-stone-950'
                      : 'bg-[#07151f] border border-sky-800/60 text-stone-300'
                  }`}
                >
                  {r * 2 + 1}×{r * 2 + 1}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            {BRUSH_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setBrushKind(opt.id)}
                className={`min-h-[40px] px-2 rounded-xl text-[11px] font-bold border ${
                  brushKind === opt.id
                    ? 'bg-sky-400 border-sky-300 text-stone-950'
                    : 'bg-[#07151f] border-sky-800/60 text-sky-100'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {brushKind === 'zone' ? (
            <div className="space-y-1">
              <label className="text-[11px] text-sky-200 font-semibold block">
                Select District Zone ({ZONE_META[brushZone].bonusText})
              </label>
              <select
                value={brushZone}
                onChange={(e) => setBrushZone(e.target.value as ZoneType)}
                className="w-full min-h-[44px] px-3 rounded-xl bg-[#07151f] border border-sky-700/70 text-xs font-semibold text-stone-100"
              >
                {(Object.keys(ZONE_META) as ZoneType[]).map((z) => (
                  <option key={z} value={z}>
                    {ZONE_META[z].name} — {ZONE_META[z].bonusText}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <p className="text-[11px] text-stone-300 leading-snug">
            {brushKind === 'logging_permit'
              ? 'Grants tree-harvesting access to Automated Logging trucks even on locked forest tiles without unlocking land for construction.'
              : brushKind === 'clear_permit'
                ? 'Removes logging permits from selected forest tiles.'
                : brushKind === 'zone'
                  ? 'Paints any of the 16 specialized urban, industrial, port, or financial district zones onto unlocked tiles.'
                  : 'Paints unlocked land/water (45C/tile). Permanent Mountains can never be terraformed.'}
          </p>

          <button
            type="button"
            onClick={() => {
              GameController.setTool({
                mode: 'terrain_brush',
                brush: brushKind,
                radius: brushRadius,
                zoneType: brushKind === 'zone' ? brushZone : undefined,
              });
              if (brushKind === 'zone') {
                GameController.setOverlayMode('zones');
              }
              GameController.setActiveSheet('none');
            }}
            className="w-full min-h-[44px] px-3 rounded-xl bg-gradient-to-b from-sky-400 to-sky-500 text-stone-950 font-bold text-xs"
          >
            Activate {BRUSH_OPTIONS.find((o) => o.id === brushKind)?.label} Brush ({brushRadius * 2 + 1}×
            {brushRadius * 2 + 1}) on Map
          </button>
        </div>

        {/* Single-Tile Land <-> Water Terraforming Tools */}
        <div className="p-3 rounded-2xl bg-[#091a12] border border-emerald-800/50 space-y-2">
          <div className="flex items-center gap-2 text-xs font-bold text-sky-200">
            <Waves className="w-4 h-4 text-sky-300 shrink-0" />
            <span>Single-Tile Canal &amp; Land Reclamation (75C/tile)</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => GameController.startTerraformTool('to_water')}
              className="min-h-[44px] px-3 rounded-xl bg-sky-700 hover:bg-sky-600 text-white font-bold text-xs"
            >
              Land → Water
            </button>
            <button
              type="button"
              onClick={() => GameController.startTerraformTool('to_land')}
              className="min-h-[44px] px-3 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-xs"
            >
              Water → Land
            </button>
          </div>
        </div>
      </div>
    </SheetContainer>
  );
};
