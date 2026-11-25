# UKUS Civilization Builder — Simulation Upgrade

Committed on `arena/e77a68b1-worldkix102`. Everything here fixes the simulation
underneath the game; no existing gameplay, building, or save format was discarded.

## How to run

```bash
npm install --legacy-peer-deps     # vite 8 + esbuild peer range
npm run dev                        # http://localhost:3000
npm run build                      # production bundle
npx tsc --noEmit                   # type check (repo's lint)
```

## The three layers (kept separate, wired together)

| Layer | Owner | Truth |
|---|---|---|
| 1. Road connectivity | `RoadNetworkSystem` | bidirectional logical graph + junction registry |
| 2. Traffic | `LogisticsAndTransportSystem` | lanes, signals, reservations, queues |
| 3. Utilities | `UtilityNetworkSystem` | grid-keyed nodes, independent of lanes/width |

`NetworkDiagnosticsSystem` reads all three and explains every failure. Utilities
never infer supply from city totals, and roads never create utility links.

## 1–4 · Trees and forestry

* **Lifecycle** — `Empty → Sapling → Young → Mature` with real timers, persisted
  per tile (`ChunkData.featureStage`, chunk save v4). Felled tiles wait out a
  harvest cooldown, so nothing reappears instantly.
* **Owned land never regrows** by itself. Locked land reseeds up to a
  **biome-relative canopy target** (jungle 34 / forest 30 / grassland 14 per 7×7
  patch). The old flat cap of 13 froze regrowth in any healthy forest — that is
  fixed.
* **New `ForestryFleetSystem`** owns work zones, trucks and crews:
  * 6-person crew rides in the truck, fells trees, carries logs back and loads.
    **Trucks never cut trees.**
  * Trips target 30–40 trees, always clamped by cargo capacity. Cargo only
    increases on delivery to the truck, so the loaded/empty sprite can never
    disagree with inventory.
  * **Road-first parking search**: candidates come from the road graph, so a
    returned plan is guaranteed drivable. Tree-first search was picking spots on
    stubs the truck could never reach.
  * One truck per forest block, reservations rebuilt every 15 ticks so an
    abandoned trip cannot permanently reserve trees.
  * Every refusal sets a reason and a code (`forestry_no_connector`,
    `forestry_no_mature_trees`, `vehicle_unreachable`, `building_no_road_access`).

## 5–7 · Connectors and road quality

* Connectors are real graph nodes bridging owned ↔ locked roads; placement is
  validated against the border, and the graph recomputes on every change.
* `roads.data.ts` now carries lanes, width class, capacity/h, quality, heavy-truck
  suitability and `utilityTrunk`.
* Routing cost multiplies ×9 for a class that is not permitted on a road (×4 for
  others), so heavy trucks only touch narrow streets when nothing else exists.

## 8–10 · Lanes, traffic, pedestrians

* Lane index and right-hand offset per road (`lanesPerDirection`), shared by cars
  and trucks in one system.
* Per-edge ordering with hard/soft following gaps — vehicles queue but never
  overlap, and coincident vehicles separate deterministically.
* Intersection reservation with expiry, signal compliance, and a bounded deadlock
  breaker so jams always clear. Signals sync per intersection with a green split
  proportional to each axis's lane count.
* Freight that has nothing to haul **parks** instead of idling in the roadway.
* Pedestrians hold position rather than walking through an occupied vehicle tile.

## 11–12 · Visuals and the false-disconnection bug

* Loaded/empty truck frames follow cargo; forestry crew renders walking, chopping
  and carrying states with carried timber sprites.
* Root causes fixed for "looks connected but reports disconnected":
  * Rail tiles no longer satisfy road access.
  * Unlinked road stubs and cluster `0` are rejected, not assumed to be main.
  * One-sided tile adjacency can no longer create a phantom edge.
  * Utility source auras are actually applied (a plant 2 tiles from its own line
    now powers it).
  * Congestion/orphan scans are O(n) instead of nested building lookups.

## 13–15 · Utilities and diagnostics

* `diagnoseUtilities` names the exact building and the binding constraint:
  `not_connected_to_network`, `disconnected_section_no_source`,
  `insufficient_supply`, `distribution_overloaded`, `source_inactive`.
* New **Diagnose** tab in the inspector: road / utility / vehicle / forestry
  findings, a per-tile explanation, and utility layer counts.
* New overlays: **Road Graph** (logical edges, junctions, signals, connectors,
  broken building access), **Lanes/Signals**, **Forestry** (growth stages, work
  zones, truck destinations). Utility overlays now colour by real network state.
* Every node in the snapshot comes from live simulation data — no fake indicators.

## 16–20 · Separation, production, population, performance

* Production panel shows capacity/hr, actual/hr, produced total, outputs with
  storage, inputs with MISSING markers and the exact bottleneck. Automated
  logging reports the rate its fleet actually achieves.
* Workforce derives from the real age cohorts; `totalJobs = occupied + vacant`
  always reconciles, so population and employment can no longer double count.
* Performance: road graph rebuilt only when dirty, diagnostics cached for 20
  ticks, deep forest survey on a 400-tick cadence, pathfinding attempts bounded,
  spatial buckets for traffic instead of pairwise checks.
* Save v3: work zones migrated, chunk v4 with growth stages, derived diagnostics
  stripped from the payload and recomputed on load. Connectivity, trucks, zones
  and regrowth all survive a save/load round trip (verified).

## Verified

```
npx tsc --noEmit   → 0 errors
npx vite build     → success
```

Headless simulation checks: 9 of 10 trucks active with 0 blocked, 688 trees
harvested, regrowth cycling through young/sapling stages, and a full
save → migrate → chunk-deserialize → reload cycle that restores the fleet and
road network with diagnostics intact.
