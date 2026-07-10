// =====================================================================
//  dtcRich.ts — richer, plain-language explanations for the Fault-code
//  card: severity, real-world symptoms, drive-ability advice, and the
//  most likely causes ranked by probability.
//
//  A generic OBD scanner shows "P0301" and a dry one-liner. This turns a
//  code into what the OWNER actually needs: is it safe to drive? what will
//  it feel like? what's usually wrong? — English, offline, no backend.
//
//  Layered like dtcDict: a CATEGORY table (by SAE J2012 range, mirrors the
//  gauge's DtcCatalog.cpp) gives every well-formed code sensible content,
//  and a CURATED override adds bespoke wording for the common ones.
// =====================================================================
import { explainDtc, type DtcInfo } from './dtcDict';

export type DtcSeverity = 'stop' | 'soon' | 'minor';

export interface DtcRich {
  code: string;
  severity: DtcSeverity;      // stop = pull over · soon = check soon · minor = when convenient
  headline: string;           // plain-language one-liner ("Cylinder 1 misfires intermittently")
  systemShort: string;        // short tech tag ("Ignition system · misfire cylinder 1")
  symptoms: string[];         // what you'll actually feel behind the wheel
  drive: string;              // drive-ability advice (the banner text)
  causes: string[];           // most likely causes, ranked most→least common
  known: boolean;             // true if from the curated dictionary (vs category fallback)
}

// The severity label + tint the card shows.
export const SEVERITY_META: Record<DtcSeverity, { label: string; color: string }> = {
  stop:  { label: 'Stop soon',   color: '#e24b4a' },
  soon:  { label: 'Check soon',  color: '#ef9f27' },
  minor: { label: 'Minor',       color: '#3b9c4f' },
};

// ---- Category classifier — mirrors DtcCatalog.cpp ranges ------------------
type Cat =
  | 'misfire' | 'cat' | 'o2' | 'lean' | 'rich' | 'fuel' | 'evap' | 'egr'
  | 'maf' | 'iat' | 'ect' | 'throttle' | 'knock' | 'position' | 'coil'
  | 'vss' | 'trans' | 'volt' | 'ecu' | 'hybrid' | 'abs' | 'body' | 'network'
  | 'generic';

function categoryOf(code: string): Cat {
  const L = code[0];
  if (L === 'C') return 'abs';
  if (L === 'B') return 'body';
  if (L === 'U') return 'network';
  // Powertrain: v = the 4 printed digits as hex (P0301 → 0x0301)
  const v = parseInt(code.slice(1), 16);
  if (v >= 0x0100 && v <= 0x0109) return 'maf';
  if (v >= 0x0110 && v <= 0x0114) return 'iat';
  if (v >= 0x0115 && v <= 0x0119) return 'ect';
  if (v >= 0x011a && v <= 0x0128) return 'throttle';
  if (v >= 0x0130 && v <= 0x016f) return 'o2';
  if (v === 0x0171 || v === 0x0174) return 'lean';
  if (v === 0x0172 || v === 0x0175) return 'rich';
  if (v >= 0x0170 && v <= 0x0177) return 'fuel';
  if (v >= 0x0200 && v <= 0x020f) return 'fuel';
  if (v >= 0x0300 && v <= 0x0318) return 'misfire';
  if (v >= 0x0320 && v <= 0x0324) return 'coil';
  if (v >= 0x0325 && v <= 0x0334) return 'knock';
  if (v >= 0x0335 && v <= 0x034f) return 'position';
  if (v >= 0x0350 && v <= 0x036f) return 'coil';
  if (v >= 0x0400 && v <= 0x0419) return 'egr';
  if ((v >= 0x0420 && v <= 0x0424) || (v >= 0x0430 && v <= 0x0434)) return 'cat';
  if (v >= 0x0440 && v <= 0x045f) return 'evap';
  if (v >= 0x0500 && v <= 0x0509) return 'vss';
  if (v >= 0x0560 && v <= 0x057f) return 'volt';
  if (v >= 0x0600 && v <= 0x06ff) return 'ecu';
  if (v >= 0x0700 && v <= 0x08ff) return 'trans';
  if (v >= 0x0a00 && v <= 0x0aff) return 'hybrid';
  if (v >= 0x2100 && v <= 0x213f) return 'throttle';
  if (v >= 0x2195 && v <= 0x220f) return 'o2';
  if (v >= 0x2300 && v <= 0x231f) return 'coil';
  return 'generic';
}

// ---- Category content — every code gets this baseline --------------------
const CAT: Record<Cat, Omit<DtcRich, 'code' | 'headline' | 'systemShort' | 'known'>> = {
  misfire: {
    severity: 'soon',
    symptoms: ['Rough, shaky idle — jerks at a stop light', 'Hesitation and weak pull, worst on take-off', 'The check-engine light may flash under throttle'],
    drive: 'OK to drive gently for a short trip — but if the light is FLASHING, stop: raw fuel is washing into the catalytic converter (an expensive part).',
    causes: ['Ignition coil worn', 'Spark plug worn out', 'Clogged injector or a compression leak'],
  },
  coil: {
    severity: 'soon',
    symptoms: ['Rough idle and a stumble under load', 'Occasional loss of power', 'Check-engine light on'],
    drive: 'Drive gently and get it looked at soon — a dead coil causes a misfire that can harm the catalyst over time.',
    causes: ['Failed ignition coil', 'Coil wiring / connector fault', 'Worn spark plug'],
  },
  cat: {
    severity: 'minor',
    symptoms: ['Usually nothing you can feel', 'Maybe slightly weaker economy', 'May fail an emissions test'],
    drive: 'Safe to keep driving. Fix it before an emissions test — but first rule out a lazy oxygen sensor, which fakes this code.',
    causes: ['Aging / failing catalytic converter', 'Rear oxygen sensor drifting', 'An unfixed exhaust or fuel-trim fault upstream'],
  },
  o2: {
    severity: 'soon',
    symptoms: ['Rougher running and worse fuel economy', 'Sometimes a faint smell of fuel', 'Check-engine light on'],
    drive: 'Fine to drive. Worth fixing soon — a bad oxygen sensor makes the engine burn richer and can slowly damage the catalyst.',
    causes: ['Worn oxygen (lambda) sensor', 'Sensor wiring / connector', 'Exhaust leak near the sensor'],
  },
  lean: {
    severity: 'soon',
    symptoms: ['Hesitation and surging, especially light throttle', 'Rough idle, sometimes stalling', 'Weak power'],
    drive: 'Drive gently. A lean mixture (too much air) run hard can overheat and damage the engine — get it checked soon.',
    causes: ['Vacuum / intake air leak', 'Weak fuel pump or clogged filter', 'Dirty MAF sensor or leaking injector'],
  },
  rich: {
    severity: 'soon',
    symptoms: ['Strong fuel smell, black smoke', 'Poor fuel economy', 'Rough idle, fouled plugs'],
    drive: 'Drive gently and fix soon — a rich mixture (too much fuel) can wash oil off the bores and clog the catalyst.',
    causes: ['Leaking fuel injector', 'Faulty MAF or MAP sensor', 'High fuel pressure / bad regulator'],
  },
  fuel: {
    severity: 'soon',
    symptoms: ['Hesitation, misfire-like stumble', 'Hard starting', 'Loss of power under load'],
    drive: 'Drive gently and address soon — fuel-delivery faults tend to get worse and can strand you.',
    causes: ['Clogged or leaking injector', 'Fuel pump / filter restriction', 'Wiring to the fuel system'],
  },
  evap: {
    severity: 'minor',
    symptoms: ['Nothing you can feel', 'Occasionally a faint fuel smell', 'May fail an emissions test'],
    drive: 'Safe to drive. Often just a loose or worn fuel cap — try re-tightening the cap first.',
    causes: ['Loose / faulty fuel cap', 'Cracked EVAP hose', 'Purge or vent valve stuck'],
  },
  egr: {
    severity: 'minor',
    symptoms: ['Rough idle or light knock/ping', 'Slight power loss', 'May fail an emissions test'],
    drive: 'Safe to keep driving. Fix at your convenience — a clogged EGR raises emissions and can ping under load.',
    causes: ['Carbon-clogged EGR valve or passages', 'Stuck EGR valve', 'EGR sensor / wiring'],
  },
  maf: {
    severity: 'soon',
    symptoms: ['Hesitation and surging', 'Rough idle, sometimes stalling', 'Noticeably worse economy'],
    drive: 'Drive gently. A dirty air-flow sensor confuses fuelling — cleaning it often fixes this.',
    causes: ['Dirty mass-air-flow (MAF) sensor', 'Intake air leak after the sensor', 'MAF wiring / connector'],
  },
  iat: {
    severity: 'minor',
    symptoms: ['Usually nothing noticeable', 'Occasional hard cold-start', 'Slightly off economy'],
    drive: 'Safe to drive. An intake-air-temp sensor fault mildly affects fuelling — fix at your convenience.',
    causes: ['Faulty intake-air-temp sensor', 'Sensor wiring / connector', 'Sensor reads with the MAF (check both)'],
  },
  ect: {
    severity: 'soon',
    symptoms: ['Hard cold-starts, rough warm-up', 'Cooling fans running oddly', 'Higher fuel use when cold'],
    drive: 'Watch the temperature gauge. Fix soon — a bad coolant-temp sensor can mask real overheating.',
    causes: ['Faulty engine-coolant-temp sensor', 'Sensor wiring / connector', 'Low coolant / thermostat'],
  },
  throttle: {
    severity: 'soon',
    symptoms: ['Surging or uneven idle', 'Delayed or jumpy throttle response', 'Sometimes limp mode (reduced power)'],
    drive: 'Drive carefully — the car may drop into reduced-power mode. Get it checked soon.',
    causes: ['Dirty / worn throttle body', 'Throttle or pedal position sensor', 'Throttle actuator wiring'],
  },
  knock: {
    severity: 'minor',
    symptoms: ['Slight power / economy loss', 'Rarely felt', 'Timing pulled for safety'],
    drive: 'Safe to drive. The engine protects itself by retarding timing — fix at your convenience.',
    causes: ['Faulty knock sensor', 'Sensor wiring / connector', 'Actual engine knock (fuel / carbon)'],
  },
  position: {
    severity: 'stop',
    symptoms: ['Stalling or a no-start', 'Sudden cut-outs while driving', 'Hard starting'],
    drive: 'Get this checked before a long trip — a crank/cam position fault can stall the engine without warning.',
    causes: ['Crankshaft / camshaft position sensor', 'Sensor wiring / connector', 'Timing / reluctor-wheel issue'],
  },
  vss: {
    severity: 'minor',
    symptoms: ['Speedometer glitches', 'Odd or harsh shifting', 'Cruise control may not work'],
    drive: 'Safe to drive. A speed-sensor fault mainly upsets the gauges and shifting — fix at your convenience.',
    causes: ['Vehicle-speed sensor', 'Sensor wiring / connector', 'Related ABS / wheel-speed fault'],
  },
  trans: {
    severity: 'soon',
    symptoms: ['Harsh, slipping, or delayed shifts', 'May enter limp mode (one gear only)', 'Warning light on'],
    drive: 'Drive gently and get it checked soon — transmission faults can worsen quickly and are costly.',
    causes: ['Low / old transmission fluid', 'Shift solenoid or sensor', 'Transmission wiring / valve body'],
  },
  volt: {
    severity: 'soon',
    symptoms: ['Flickering lights, odd electronics', 'Hard starting', 'Battery / charge warnings'],
    drive: 'Get it checked soon — a charging-system fault can leave you with a flat battery.',
    causes: ['Alternator / charging fault', 'Weak battery or bad ground', 'Wiring / connector corrosion'],
  },
  ecu: {
    severity: 'soon',
    symptoms: ['Various odd behaviour', 'Warning lights', 'Sometimes a no-start'],
    drive: 'Have it scanned properly soon — internal control-module faults need a technician.',
    causes: ['Control-module internal fault', 'Power / ground to the module', 'Software / update needed'],
  },
  hybrid: {
    severity: 'stop',
    symptoms: ['Reduced power / EV mode limited', 'Warning lights', 'Charging behaviour changes'],
    drive: 'Get a hybrid-capable shop to check it soon — high-voltage faults should not be ignored.',
    causes: ['HV battery / cell issue', 'HV cooling or sensor', 'Inverter / converter fault'],
  },
  abs: {
    severity: 'soon',
    symptoms: ['ABS / traction light on', 'Normal brakes, but no ABS assist', 'Stability control may be off'],
    drive: 'Your normal brakes still work, but ABS/stability may be disabled — drive with extra care and fix soon.',
    causes: ['Wheel-speed sensor', 'Sensor wiring / connector', 'ABS module fault'],
  },
  body: {
    severity: 'minor',
    symptoms: ['A comfort / accessory feature misbehaves', 'A warning light', 'Often no drive effect'],
    drive: 'Usually safe to drive. If it involves airbags or lighting, get it checked promptly.',
    causes: ['Faulty body-control sensor / actuator', 'Wiring / connector', 'Module fault'],
  },
  network: {
    severity: 'soon',
    symptoms: ['Multiple warning lights at once', 'Gauges or features dropping out', 'Intermittent glitches'],
    drive: 'Have it scanned soon — a communication fault can make several systems act up at once.',
    causes: ['Wiring / connector on the CAN bus', 'A failing module dragging the bus', 'Ground / power fault'],
  },
  generic: {
    severity: 'soon',
    symptoms: ['Behaviour depends on the exact system', 'Often a warning light', 'May affect running or economy'],
    drive: 'Have it diagnosed to be sure. If the car drives normally and the light is steady, it is usually not an emergency.',
    causes: ['A sensor or actuator in this system', 'Wiring / connector', 'The component itself'],
  },
};

// ---- Curated per-code overrides (the common ones) ------------------------
// Only the fields that differ from the category baseline. `headline` required.
type Curated = { headline: string } & Partial<Omit<DtcRich, 'code' | 'known'>>;
const CURATED: Record<string, Curated> = {
  P0300: { headline: 'Random / multiple-cylinder misfire', systemShort: 'Ignition · random misfire',
    symptoms: ['Shaky idle, jerks at a stop', 'Weak, stumbling acceleration', 'The check-engine light may flash'],
    causes: ['Worn plugs or coils (several)', 'Vacuum / intake leak', 'Weak fuel delivery or low compression'] },
  P0420: { headline: 'Catalytic converter efficiency low (Bank 1)', systemShort: 'Emissions · catalyst bank 1' },
  P0430: { headline: 'Catalytic converter efficiency low (Bank 2)', systemShort: 'Emissions · catalyst bank 2' },
  P0171: { headline: 'Fuel mixture too lean (Bank 1)', systemShort: 'Fuel trim · lean bank 1' },
  P0174: { headline: 'Fuel mixture too lean (Bank 2)', systemShort: 'Fuel trim · lean bank 2' },
  P0172: { headline: 'Fuel mixture too rich (Bank 1)', systemShort: 'Fuel trim · rich bank 1' },
  P0175: { headline: 'Fuel mixture too rich (Bank 2)', systemShort: 'Fuel trim · rich bank 2' },
  P0128: { headline: 'Engine runs too cool (thermostat)', systemShort: 'Cooling · thermostat', severity: 'minor',
    symptoms: ['Heater slow to warm up', 'Temp gauge sits low', 'Slightly worse economy'],
    drive: 'Safe to drive. Usually a thermostat stuck open — fix at your convenience.',
    causes: ['Thermostat stuck open', 'Coolant-temp sensor', 'Low coolant level'] },
  P0442: { headline: 'Small EVAP system leak', systemShort: 'Emissions · EVAP small leak' },
  P0455: { headline: 'Large EVAP system leak', systemShort: 'Emissions · EVAP large leak' },
  P0456: { headline: 'Very small EVAP leak', systemShort: 'Emissions · EVAP tiny leak' },
  P0401: { headline: 'EGR flow insufficient', systemShort: 'Emissions · EGR flow low' },
  P0102: { headline: 'Mass air-flow sensor reads low', systemShort: 'Air metering · MAF low' },
  P0101: { headline: 'Mass air-flow sensor out of range', systemShort: 'Air metering · MAF range' },
  P0135: { headline: 'O2 sensor heater fault (Bank 1 Sensor 1)', systemShort: 'Oxygen sensor · heater B1S1' },
  P0700: { headline: 'Transmission control system fault', systemShort: 'Transmission · control request' },
  P0507: { headline: 'Idle speed higher than expected', systemShort: 'Idle control · RPM high', severity: 'minor',
    symptoms: ['Idle sits high', 'Slight lurch when stopping', 'Usually drives fine'],
    causes: ['Vacuum leak', 'Dirty throttle body / idle valve', 'Throttle body needs relearn'] },
  U0100: { headline: 'Lost communication with the engine computer', systemShort: 'Network · lost comms ECM' },
};

// Cylinder-specific misfire headlines (P0301..P0312 → cylinder 1..12).
function misfireCurated(code: string): Curated | null {
  const v = parseInt(code.slice(1), 16);
  if (v >= 0x0301 && v <= 0x030c) {
    const cyl = v - 0x0300;
    return {
      headline: `Cylinder ${cyl} misfires intermittently`,
      systemShort: `Ignition · misfire cylinder ${cyl}`,
      causes: [`Cylinder ${cyl} ignition coil worn`, `Cylinder ${cyl} spark plug worn out`, `Clogged injector or compression leak on cylinder ${cyl}`],
    };
  }
  return null;
}

/** Rich, plain-language explanation for a code. Always returns something usable
 *  (category fallback) for any well-formed code; `null` only for garbage input. */
export function richDtc(rawCode: string): DtcRich | null {
  const info: DtcInfo | null = explainDtc(rawCode);
  if (!info) return null;
  const code = info.code;
  const base = CAT[categoryOf(code)];
  const curated = CURATED[code] ?? misfireCurated(code);

  return {
    code,
    severity: curated?.severity ?? base.severity,
    headline: curated?.headline ?? info.title,
    systemShort: curated?.systemShort ?? info.system,
    symptoms: curated?.symptoms ?? base.symptoms,
    drive: curated?.drive ?? base.drive,
    causes: curated?.causes ?? base.causes,
    known: !!curated || info.known,
  };
}
