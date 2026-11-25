import React from 'react';
import {
  Axe,
  Compass,
  FlaskConical,
  Hammer,
  Landmark,
  Map as MapIcon,
  Sprout,
  Users,
  Check,
  X,
  Crosshair,
  Plus,
  Minus,
  Trash2,
  RotateCw,
  Hand,
  Paintbrush,
  Waves,
} from 'lucide-react';
import { BUILDINGS, getBuildingFootprint } from '../../data/buildings.data';
import { GameController, GameSnapshot } from '../bridge/GameController';

interface BottomDockProps {
  snap: GameSnapshot;
}

export const BottomDock: React.FC<BottomDockProps> = ({ snap }) => {
  const { tool, ghostInfo, activeSheet, activeQuest, state, panMode } = snap;
  const isBuildGhost = tool.mode === 'build';
  const isMoveGhost = tool.mode === 'move';
  const isGhostMode = isBuildGhost || isMoveGhost;
  const movingBldg = isMoveGhost
    ? state.buildings.find((b) => b.id === tool.buildingId)
    : undefined;
  const ghostDef = isBuildGhost
    ? BUILDINGS[tool.defId]
    : movingBldg
      ? BUILDINGS[movingBldg.defId]
      : null;

  const ghostRot: 0 | 1 = isBuildGhost
    ? (tool.rotation ?? 0)
    : isMoveGhost
      ? (tool.rotation ?? movingBldg?.rotation ?? 0)
      : 0;
  const ghostFp = ghostDef ? getBuildingFootprint(ghostDef, ghostRot) : null;
  const canRotateGhost = Boolean(
    ghostDef && ghostDef.width !== ghostDef.height && ghostDef.footprintRotatable !== false
  );

  const isBrushMode =
    tool.mode === 'terraform' ||
    tool.mode === 'terrain_brush' ||
    tool.mode === 'rect_land' ||
    tool.mode === 'road' ||
    tool.mode === 'land_unlock' ||
    tool.mode === 'demolish' ||
    tool.mode === 'place_utility' ||
    tool.mode === 'remove_utility';

  const showChopHint =
    state.stats.treesCut === 0 &&
    !isGhostMode &&
    !isBrushMode &&
    !snap.selectedTile &&
    !snap.selectedBuildingId;

  return (
    <div className="pointer-events-none w-full max-w-full flex flex-col gap-2 px-2.5 pb-safe">
      {/* Right-Edge Terraform & Recenter Controls */}
      {!isGhostMode && (
        <div className="flex justify-end pr-0.5">
          <div className="pointer-events-auto flex flex-col gap-1.5 bg-gradient-to-b from-[#13291e]/94 to-[#08150f]/95 backdrop-blur-md border border-emerald-700/45 rounded-2xl p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_8px_20px_rgba(0,0,0,0.4)]">
            <button
              type="button"
              aria-label="Paint Water"
              onClick={() => GameController.startTerraformTool('to_water')}
              className={`w-11 h-11 rounded-xl border flex items-center justify-center transition-colors ${
                tool.mode === 'terraform' && tool.action === 'to_water'
                  ? 'bg-sky-400 border-sky-300 text-stone-950 font-bold'
                  : 'bg-[#0a1c13] hover:bg-sky-950/80 border-sky-800/60 text-sky-300'
              }`}
              title="Paint Water (75C)"
            >
              <Waves className="w-4 h-4" />
            </button>
            <button
              type="button"
              aria-label="Reclaim Land"
              onClick={() => GameController.startTerraformTool('to_land')}
              className={`w-11 h-11 rounded-xl border flex items-center justify-center transition-colors ${
                tool.mode === 'terraform' && tool.action === 'to_land'
                  ? 'bg-emerald-400 border-emerald-300 text-stone-950 font-bold'
                  : 'bg-[#0a1c13] hover:bg-emerald-900/80 border-emerald-800/50 text-emerald-300'
              }`}
              title="Reclaim Land (75C)"
            >
              <Sprout className="w-4 h-4" />
            </button>
            <button
              type="button"
              aria-label="Recenter camera"
              onClick={() => GameController.centerCamera()}
              className="w-11 h-11 rounded-xl bg-[#0a1c13] hover:bg-emerald-900/80 border border-emerald-800/50 text-amber-300 flex items-center justify-center transition-colors"
              title="Recenter Camera"
            >
              <Crosshair className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Non-blocking Initial Clearing Prompt */}
      {showChopHint ? (
        <div className="pointer-events-none mx-auto max-w-full bg-gradient-to-b from-[#163225]/92 to-[#0b1b13]/94 backdrop-blur-md border border-amber-500/45 rounded-xl px-3.5 py-2 shadow-lg flex items-center gap-2 text-xs text-stone-100">
          <Axe className="w-4 h-4 text-amber-400 shrink-0" />
          <span>Tap trees inside your sunlit estate to chop wood &amp; earn coins</span>
        </div>
      ) : null}

      {/* Active Draggable Terraform Mode Banner */}
      {tool.mode === 'terraform' ? (
        <div className="pointer-events-auto mx-auto w-full max-w-md min-w-0 bg-gradient-to-b from-[#0f2938]/96 to-[#081722]/96 backdrop-blur-md border border-sky-500/60 rounded-2xl p-2.5 flex flex-wrap items-center justify-between gap-2 shadow-lg">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <Waves className="w-4 h-4 text-sky-300 shrink-0" />
            <div className="flex items-center gap-1 min-w-0">
              <button
                type="button"
                onClick={() => GameController.startTerraformTool('to_water')}
                className={`min-h-[44px] px-2.5 rounded-xl text-xs font-bold transition-colors whitespace-nowrap ${
                  tool.action === 'to_water'
                    ? 'bg-sky-400 text-stone-950'
                    : 'bg-[#091c28] border border-sky-700/60 text-sky-200'
                }`}
              >
                To Water (75C)
              </button>
              <button
                type="button"
                onClick={() => GameController.startTerraformTool('to_land')}
                className={`min-h-[44px] px-2.5 rounded-xl text-xs font-bold transition-colors whitespace-nowrap ${
                  tool.action === 'to_land'
                    ? 'bg-emerald-400 text-stone-950'
                    : 'bg-[#091c28] border border-emerald-700/60 text-emerald-200'
                }`}
              >
                To Land (75C)
              </button>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => GameController.setPanMode(!panMode)}
              className={`min-h-[44px] px-2.5 rounded-xl text-xs font-bold flex items-center gap-1 ${
                panMode
                  ? 'bg-amber-400 text-stone-950'
                  : 'bg-[#091c28] border border-sky-600/60 text-stone-100'
              }`}
            >
              {panMode ? <Hand className="w-3.5 h-3.5" /> : <Paintbrush className="w-3.5 h-3.5" />}
              {panMode ? 'Pan' : 'Paint'}
            </button>
            <button
              type="button"
              onClick={() => GameController.setTool({ mode: 'inspect_chop' })}
              className="min-h-[44px] px-3 rounded-xl bg-sky-700 hover:bg-sky-600 text-white text-xs font-bold shrink-0"
            >
              Done
            </button>
          </div>
        </div>
      ) : isBrushMode ? (
        <div
          className={`pointer-events-auto mx-auto w-full max-w-md min-w-0 backdrop-blur-md border rounded-2xl px-3 py-2 flex items-center justify-between gap-2 shadow-lg ${
            tool.mode === 'demolish' || tool.mode === 'remove_utility'
              ? 'bg-gradient-to-b from-red-950/95 to-[#1a0909]/95 border-red-600/60 text-red-100'
              : 'bg-gradient-to-b from-[#142c20]/96 to-[#08160f]/96 border-emerald-600/60 text-stone-100'
          }`}
        >
          <div className="flex items-center gap-2 min-w-0 text-xs">
            {tool.mode === 'demolish' || tool.mode === 'remove_utility' ? (
              <Trash2 className="w-4 h-4 text-red-400 shrink-0" />
            ) : (
              <Paintbrush className="w-4 h-4 text-amber-300 shrink-0" />
            )}
            <span className="truncate font-semibold">
              {panMode
                ? 'Pan Mode: Drag to scroll map'
                : tool.mode === 'demolish'
                  ? 'Remove: Tap/drag roads, trees & buildings'
                  : tool.mode === 'road'
                    ? 'Road Brush: Tap or drag along tiles'
                    : tool.mode === 'land_unlock'
                      ? 'Expand: Tap or drag border tiles'
                      : tool.mode === 'rect_land'
                        ? 'Rect Land Tool: Use Land sheet to preview & buy'
                        : tool.mode === 'terrain_brush'
                          ? `Terrain Brush (${tool.brush.replace('_', ' ')} · ${tool.radius * 2 + 1}×${tool.radius * 2 + 1}): Tap/drag`
                          : tool.mode === 'place_utility'
                            ? 'Utility Brush: Tap or drag tiles'
                            : 'Remove Utility: Tap or drag tiles'}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => GameController.setPanMode(!panMode)}
              className={`min-h-[44px] px-2.5 rounded-xl text-xs font-bold flex items-center gap-1 ${
                panMode
                  ? 'bg-amber-400 text-stone-950'
                  : 'bg-black/35 border border-white/20 text-stone-100'
              }`}
            >
              {panMode ? <Hand className="w-3.5 h-3.5" /> : <Paintbrush className="w-3.5 h-3.5" />}
              {panMode ? 'Pan' : 'Paint'}
            </button>
            <button
              type="button"
              onClick={() => GameController.setTool({ mode: 'inspect_chop' })}
              className={`min-h-[44px] px-3 rounded-xl text-white text-xs font-bold shrink-0 ${
                tool.mode === 'demolish' || tool.mode === 'remove_utility'
                  ? 'bg-red-800/90 hover:bg-red-700'
                  : 'bg-emerald-700 hover:bg-emerald-600'
              }`}
            >
              Done
            </button>
          </div>
        </div>
      ) : null}

      {/* Contextual Floating Action Bars (Build/Move Ghost Confirm OR Quest Card + Tool Switcher) */}
      {isGhostMode && ghostDef && ghostFp ? (
        <div className="pointer-events-auto mx-auto w-full max-w-md min-w-0 bg-gradient-to-b from-[#152e22]/96 to-[#091710]/97 backdrop-blur-md border border-emerald-700/60 rounded-2xl px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_12px_30px_rgba(0,0,0,0.5)]">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-bold text-stone-100 truncate">
              {isMoveGhost ? 'Move' : 'Place'} {ghostDef.name} ({ghostFp.width}×{ghostFp.height})
            </div>
            <div className="text-[11px] text-stone-300 truncate tabular-nums">
              {ghostInfo
                ? ghostInfo.valid
                  ? `Tile (${ghostInfo.gx}, ${ghostInfo.gy}) · Tap Confirm or tap tile again`
                  : ghostInfo.reason
                : 'Tap any flat cleared tile'}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => GameController.setTool({ mode: 'inspect_chop' })}
              className="min-w-[44px] min-h-[44px] px-3 rounded-xl bg-stone-800/90 border border-stone-600/60 text-stone-200 flex items-center justify-center hover:bg-stone-700"
              aria-label={isMoveGhost ? 'Cancel move' : 'Cancel build'}
            >
              <X className="w-4 h-4" />
            </button>
            {canRotateGhost ? (
              <button
                type="button"
                onClick={() => GameController.rotateTool()}
                className="min-w-[44px] min-h-[44px] px-3 rounded-xl bg-[#0d2433] border border-sky-600/60 text-sky-200 font-bold text-xs flex items-center justify-center gap-1"
                aria-label="Rotate footprint"
              >
                <RotateCw className="w-4 h-4" />
                Rotate
              </button>
            ) : null}
            {ghostInfo?.blockingObstacleTiles && ghostInfo.blockingObstacleTiles.length > 0 ? (
              <button
                type="button"
                onClick={() => GameController.clearGhostObstacles()}
                className="min-h-[44px] px-3 rounded-xl bg-gradient-to-b from-lime-500 to-lime-600 text-stone-950 font-bold text-xs flex items-center gap-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_3px_0_#365314]"
              >
                Clear ({ghostInfo.blockingObstacleTiles.length})
              </button>
            ) : null}
            <button
              type="button"
              disabled={!ghostInfo?.valid}
              onClick={() => GameController.confirmGhostBuild()}
              className="min-w-[44px] min-h-[44px] px-3.5 rounded-xl bg-gradient-to-b from-amber-400 to-amber-500 disabled:from-stone-700 disabled:to-stone-800 disabled:text-stone-400 text-stone-950 font-bold text-xs flex items-center gap-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_3px_0_#92400e] disabled:shadow-none active:translate-y-[2px]"
            >
              <Check className="w-4 h-4" />
              {isMoveGhost ? 'Move' : 'Build'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-end justify-between gap-2 min-w-0">
          {/* Active Guided Quest Strip */}
          {activeQuest ? (
            <div className="pointer-events-auto max-w-[200px] sm:max-w-xs min-w-0 bg-gradient-to-b from-[#142c20]/94 to-[#091610]/95 backdrop-blur-md border border-emerald-700/45 rounded-xl px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_6px_18px_rgba(0,0,0,0.4)]">
              <div className="flex items-center justify-between gap-2 text-[11px] font-bold text-amber-300">
                <span className="truncate min-w-0">{activeQuest.quest.title}</span>
                <span className="tabular-nums shrink-0 text-amber-200">
                  {activeQuest.progress}/{activeQuest.quest.targetValue}
                </span>
              </div>
              <div className="text-[10px] text-stone-300 truncate mt-0.5">{activeQuest.quest.description}</div>
              <div className="w-full h-1 bg-[#06110b] rounded-sm overflow-hidden mt-1.5">
                <div
                  className="h-full bg-amber-400 transition-all duration-200"
                  style={{
                    width: `${Math.min(100, Math.round((activeQuest.progress / activeQuest.quest.targetValue) * 100))}%`,
                  }}
                />
              </div>
            </div>
          ) : (
            <div />
          )}

          {/* Quick Map Tools: Inspect/Chop, Sapling, Remove/Bulldoze */}
          <div className="pointer-events-auto flex items-center gap-1 bg-gradient-to-b from-[#13291e]/94 to-[#08150f]/95 backdrop-blur-md border border-emerald-700/45 rounded-2xl p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_8px_20px_rgba(0,0,0,0.4)]">
            <button
              type="button"
              title="Chop / Inspect"
              aria-label="Chop or inspect tool"
              onClick={() => GameController.setTool({ mode: 'inspect_chop' })}
              className={`min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center transition-all ${
                tool.mode === 'inspect_chop'
                  ? 'bg-gradient-to-b from-amber-400 to-amber-500 text-stone-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_2px_0_#92400e]'
                  : 'text-stone-300 hover:text-white hover:bg-emerald-950/60'
              }`}
            >
              <Axe className="w-4 h-4" />
            </button>
            <button
              type="button"
              title="Plant Sapling"
              aria-label="Plant sapling tool"
              onClick={() => GameController.setTool({ mode: 'replant' })}
              className={`min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center transition-all ${
                tool.mode === 'replant'
                  ? 'bg-gradient-to-b from-emerald-400 to-emerald-500 text-stone-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_2px_0_#065f46]'
                  : 'text-stone-300 hover:text-white hover:bg-emerald-950/60'
              }`}
            >
              <Sprout className="w-4 h-4" />
            </button>
            <button
              type="button"
              title="Remove Roads, Trees or Buildings"
              aria-label="Remove tool"
              onClick={() =>
                GameController.setTool(
                  tool.mode === 'demolish' ? { mode: 'inspect_chop' } : { mode: 'demolish' }
                )
              }
              className={`min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center transition-all ${
                tool.mode === 'demolish'
                  ? 'bg-gradient-to-b from-red-500 to-red-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_2px_0_#7f1d1d]'
                  : 'text-stone-300 hover:text-red-300 hover:bg-red-950/40'
              }`}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Primary 5-Tab Sculpted Bottom Navigation Dock */}
      <nav className="pointer-events-auto mx-auto w-full max-w-2xl bg-gradient-to-b from-[#142c20]/96 to-[#08150f]/97 backdrop-blur-md border border-emerald-700/50 rounded-2xl grid grid-cols-5 gap-1 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_10px_30px_rgba(0,0,0,0.55)]">
        <DockTab
          icon={<Hammer className="w-5 h-5" />}
          label="Build"
          active={activeSheet === 'build'}
          onClick={() => GameController.setActiveSheet('build')}
        />
        <DockTab
          icon={<MapIcon className="w-5 h-5" />}
          label="Land"
          active={
            activeSheet === 'land' ||
            tool.mode === 'land_unlock' ||
            tool.mode === 'rect_land' ||
            tool.mode === 'terrain_brush' ||
            Boolean(state.landModeActive)
          }
          onClick={() => GameController.setActiveSheet('land')}
        />
        <DockTab
          icon={<Landmark className="w-5 h-5" />}
          label="Economy"
          active={activeSheet === 'economy'}
          onClick={() => GameController.setActiveSheet('economy')}
        />
        <DockTab
          icon={<Users className="w-5 h-5" />}
          label="Society"
          active={activeSheet === 'population'}
          onClick={() => GameController.setActiveSheet('population')}
        />
        <DockTab
          icon={<FlaskConical className="w-5 h-5" />}
          label="Tech"
          active={activeSheet === 'tech'}
          onClick={() => GameController.setActiveSheet('tech')}
        />
      </nav>
    </div>
  );
};

interface DockTabProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}

const DockTab: React.FC<DockTabProps> = ({ icon, label, active, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`min-h-[50px] flex flex-col items-center justify-center rounded-xl transition-all ${
      active
        ? 'bg-gradient-to-b from-amber-400 to-amber-500 text-stone-950 font-bold shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_2px_0_#92400e]'
        : 'text-stone-200 hover:text-white hover:bg-[#163124]/80 border border-transparent hover:border-emerald-800/40'
    }`}
  >
    {icon}
    <span className="text-[11px] font-semibold mt-0.5 whitespace-nowrap">{label}</span>
  </button>
);

export { Compass };
