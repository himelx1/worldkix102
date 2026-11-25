import { BUILDINGS, getBuildingFootprint } from '../data/buildings.data';
import { BuildingInstance, WorldEngineState, ZONE_ID_TO_TYPE, ZoneId, ZoneType } from '../core/GameState';

export interface BuildingServiceCoverage {
  hasCivicHqOrSub: boolean;
  hasTaxCoverage: boolean;
  hasEducationCoverage: boolean;
  hasWorkerCoverage: boolean;
  hasGovCoverage: boolean;
  taxBonusMult: number;
  prodBonusMult: number;
  educationBonusMult: number;
}

const ZONE_PROD_BONUSES: Partial<Record<ZoneType, number>> = {
  industrial: 1.12,
  heavy_industrial: 1.22,
  agricultural: 1.18,
  sez: 1.2,
  epz: 1.25,
  fishing: 1.25,
  mining: 1.22,
  forestry: 1.25,
  logistics: 1.2,
  port: 1.18,
  tech_park: 1.25,
  research: 1.22,
};

const ZONE_TAX_BONUSES: Partial<Record<ZoneType, number>> = {
  residential: 1.1,
  commercial: 1.15,
  financial: 1.25,
  government: 1.18,
  sez: 1.2,
  epz: 1.22,
  port: 1.16,
};

/**
 * Evaluates local district service coverage provided by Regional Sub-Offices,
 * Government institutions, and 16 district zones.
 */
export class DistrictServiceSystem {
  public static getZoneBonuses(zoneId: ZoneId | number): { prodMult: number; taxMult: number } {
    const zt = ZONE_ID_TO_TYPE[zoneId] ?? 'none';
    return {
      prodMult: ZONE_PROD_BONUSES[zt] ?? 1.0,
      taxMult: ZONE_TAX_BONUSES[zt] ?? 1.0,
    };
  }

  public static getBuildingCoverage(
    b: BuildingInstance,
    state: WorldEngineState,
    tileZoneId?: ZoneId | number
  ): BuildingServiceCoverage {
    const def = BUILDINGS[b.defId];
    const fp = def ? getBuildingFootprint(def, b.rotation ?? 0) : { width: 1, height: 1 };
    const cx = b.gx + fp.width * 0.5;
    const cy = b.gy + fp.height * 0.5;

    let hasCivicHqOrSub = false;
    let hasTaxCoverage = false;
    let hasEducationCoverage = false;
    let hasWorkerCoverage = false;
    let hasGovCoverage = false;

    for (const office of state.buildings) {
      if (office.status === 'constructing' || !office.enabled) continue;
      const oDef = BUILDINGS[office.defId];
      if (!oDef || (!oDef.isMainHq && !oDef.isSubOffice && oDef.category !== 'government')) continue;

      const oFp = getBuildingFootprint(oDef, office.rotation ?? 0);
      const ox = office.gx + oFp.width * 0.5;
      const oy = office.gy + oFp.height * 0.5;
      const dist = Math.hypot(cx - ox, cy - oy);

      const radius = oDef.isSubOffice
        ? (oDef.serviceRadius ?? 12) + (office.level - 1) * 2
        : 28 + (office.level - 1) * 4;
      const inSameCity = (office.cityId ?? 1) === (b.cityId ?? 1);
      const covers = oDef.isMainHq || oDef.category === 'government' ? inSameCity || dist <= radius : dist <= radius;
      if (!covers) continue;

      if (
        office.defId === 'main_town_hall' ||
        office.defId === 'sub_town_hall' ||
        office.defId === 'city_hall' ||
        office.defId === 'government_hq' ||
        office.defId === 'parliament_building'
      ) {
        hasCivicHqOrSub = true;
      }
      if (
        office.defId === 'government_office' ||
        office.defId === 'sub_government_office' ||
        office.defId === 'government_hq' ||
        office.defId === 'parliament_building' ||
        office.defId === 'court_house' ||
        office.defId === 'public_records_office'
      ) {
        hasGovCoverage = true;
      }
      if (
        office.defId === 'tax_office' ||
        office.defId === 'sub_tax_office' ||
        office.defId === 'regional_tax_office' ||
        office.defId === 'ministry_finance'
      ) {
        hasTaxCoverage = true;
      }
      if (
        office.defId === 'education_ministry' ||
        office.defId === 'sub_education_office' ||
        office.defId === 'ministry_agriculture' ||
        office.defId === 'census_office'
      ) {
        hasEducationCoverage = true;
      }
      if (
        office.defId === 'worker_office' ||
        office.defId === 'sub_worker_office' ||
        office.defId === 'employment_office' ||
        office.defId === 'ministry_trade' ||
        office.defId === 'ministry_transport'
      ) {
        hasWorkerCoverage = true;
      }
    }

    const zBonus = tileZoneId !== undefined ? this.getZoneBonuses(tileZoneId) : { prodMult: 1.0, taxMult: 1.0 };

    return {
      hasCivicHqOrSub,
      hasTaxCoverage,
      hasEducationCoverage,
      hasWorkerCoverage,
      hasGovCoverage,
      taxBonusMult: (hasTaxCoverage ? 1.15 : 1.0) * zBonus.taxMult,
      prodBonusMult: (hasWorkerCoverage ? 1.12 : 1.0) * (hasGovCoverage ? 1.05 : 1.0) * zBonus.prodMult,
      educationBonusMult: hasEducationCoverage ? 1.25 : 1.0,
    };
  }

  public static computeWorldServiceCoveragePct(state: WorldEngineState): number {
    const targets = state.buildings.filter((b) => {
      if (b.status === 'constructing') return false;
      const def = BUILDINGS[b.defId];
      return Boolean(def && !def.isMainHq && !def.isSubOffice && def.category !== 'government');
    });
    if (targets.length === 0) return 100;

    let covered = 0;
    for (const b of targets) {
      const cov = this.getBuildingCoverage(b, state);
      if (
        cov.hasCivicHqOrSub ||
        cov.hasTaxCoverage ||
        cov.hasEducationCoverage ||
        cov.hasWorkerCoverage ||
        cov.hasGovCoverage
      ) {
        covered++;
      }
    }
    const pct = Math.round((covered / targets.length) * 100);
    if (state.utilitySummary) {
      state.utilitySummary.serviceCoveragePct = pct;
    }
    return pct;
  }
}
