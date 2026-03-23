/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  Activity, 
  Zap, 
  Cpu, 
  Settings, 
  Play, 
  Square, 
  RefreshCw, 
  CheckCircle2, 
  AlertCircle, 
  Terminal, 
  Maximize2, 
  Copy,
  Info,
  ChevronRight,
  Database,
  BrainCircuit,
  Check
} from "lucide-react";
import { GoogleGenAI } from "@google/genai";

// ============================================================
// FİZİKSEL SABİTLER & KONFİGÜRASYON
// ============================================================
const PHY = {
  Vpeak:    230 * Math.sqrt(2), // 325.27V
  f_ac:     50,
  Vout_ref: 400,
  L:        400e-6,   // Görsel 3/4: 400µH (Metindeki 1.2m ile çelişki, görsel esas alındı)
  C:        820e-6,   // Görsel 1: 820µF
  P_out:    1000,     
  P_in_max: 1100,     
  R:        160,      
  fsw:      100e3,
  Ts:       5e-7,     
  // Kayıp Parametreleri
  RL:       0.050,    
  RC:       0.020,    
  Vd:       0.8,      
  // ADC Sensör Kazançları (Görsel 1'deki "K" kutuları)
  K_VDC:    0.005,    // A0: PFC_VoutSEN (1/0.005 = 200 çarpanı)
  K_VAC:    0.006,    // A1: VinSEN (1/0.006 = 166.67 çarpanı)
  K_IL:     0.3,      // A2,A3,A4: i_PFC_FAZ1,2,3 (1/0.3 = 3.33 çarpanı)
  // EMI Filtre (Görsel 4)
  L_DM:     100e-6,
  L_CM:     10e-3,
  X_Cap:    600e-9,
};

// B0 fiziksel hesabı — Velocity-form PI (Tustin)
function calcB0(fc_i: number, fc_z_ratio = 0.1) {
  const Kp = PHY.L * 2 * Math.PI * fc_i / PHY.Vout_ref;
  const Ki = Kp * 2 * Math.PI * (fc_i * fc_z_ratio);
  const B0 = Kp + Ki * PHY.Ts / 2;
  const B1 = -Kp + Ki * PHY.Ts / 2;
  return { B0, B1, Ki, Kp, fc_i };
}

const b10 = calcB0(10000), b15 = calcB0(15000), b20 = calcB0(20000);

// ============================================================
// PSIM UYUMLU ORTALAMA MODEL SİMÜLATÖRÜ
// ============================================================
function simulatePFC(p: any) {
  const { B0, B1, B2, A1, A2, KP_V, KI_V, V_INT_MAX,
          I_MAG_MAX, SOFTSTART_TIME, DUTY_MAX, DUTY_MIN } = p;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const R = PHY.R;

  const dt = PHY.Ts;
  const T  = 0.12;
  const steps = Math.floor(T / dt); 
  const skip  = Math.max(1, Math.floor(steps / 700));

  const I_ss = PHY.P_out / (PHY.Vout_ref * 0.99 * 3); 
  let Vout = PHY.Vout_ref;
  let vdc_ref = 311.0;            
  let v_int = 0, v_err_p = 0;
  let e1 = [0,0,0], e2 = [0,0,0];
  let u1 = [0,0,0], u2 = [0,0,0];
  let diL_p = [0,0,0], dV_p = 0;
  let iL = [I_ss, I_ss, I_ss];

  const rec: any = { t:[], vout:[], vin:[], iac:[], iref:[], il:[[],[],[]], eff:[] };

  // F28004x 12-bit ADC & Limiter Modeli
  const adc_read = (val: number, K: number) => {
    let pin_v = val * K;
    if (pin_v > 3.3) pin_v = 3.3; // Donanımsal Limiter (Şemadaki kırık çizgili kutu)
    if (pin_v < 0) pin_v = 0;
    let adc_res = Math.floor((pin_v / 3.3) * 4095); // 12-bit ADC Çevrimi (0-4095)
    return (adc_res * (3.3 / 4095)) / K; // DSP'nin gördüğü dijitalleştirilmiş gerçek değer
  };

  for (let n = 0; n < steps; n++) {
    const t     = n * dt;
    const sin_t = Math.sin(2 * Math.PI * PHY.f_ac * t);
    const Vin   = Math.abs(PHY.Vpeak * sin_t);
    const sv    = sin_t >= 0 ? 1 : -1;

    // Gerçek Vout (ESR dahil)
    const i_load = Vout / R;
    const i_cap_prev = (iL[0] + iL[1] + iL[2]) * 0.5 - i_load; // Yaklaşık
    const Vout_real = Vout + i_cap_prev * PHY.RC;

    // DSP'nin okuduğu sensör değerleri (ADC Kuantalama ve Limiter dahil)
    const Vout_meas = adc_read(Vout_real, PHY.K_VDC);
    const Vin_meas  = adc_read(Vin, PHY.K_VAC);

    if (vdc_ref < PHY.Vout_ref)
      vdc_ref += 89 * (dt / Math.max(SOFTSTART_TIME, 0.001));
    else
      vdc_ref = PHY.Vout_ref;

    const v_err    = vdc_ref - Vout_meas;
    const vi_new   = v_int + KI_V * dt * 0.5 * (v_err + v_err_p);
    v_int          = clamp(vi_new, -V_INT_MAX, V_INT_MAX); 
    let I_mag      = clamp(KP_V * v_err + v_int, 0, I_MAG_MAX);
    if (Vout_meas > 430) I_mag = 0; 
    v_err_p        = v_err;

    const Iref = I_mag * (Vin_meas / PHY.Vpeak);

    let dff = 0;
    if (Vin_meas > 2 && Vout_meas > Vin_meas + 1) {
      dff = clamp(1 - Vin_meas / Vout_meas, 0, 0.92);
    }

    let i_cap = 0;
    let p_loss = 0;
    for (let ph = 0; ph < 3; ph++) {
      const iL_meas = adc_read(iL[ph], PHY.K_IL);
      const en = Iref - iL_meas;

      const u_raw = B0*en + B1*e1[ph] + B2*e2[ph] - A1*u1[ph] - A2*u2[ph];
      const u_c   = clamp(u_raw, -0.92, 0.92);
      const d     = clamp(dff + u_c, DUTY_MIN, DUTY_MAX);

      const aw_pos = u_raw >  0.92 && en > 0;
      const aw_neg = u_raw < -0.92 && en < 0;
      e2[ph] = e1[ph]; e1[ph] = en;
      u2[ph] = u1[ph];
      u1[ph] = (aw_pos || aw_neg) ? u1[ph] * 0.98 : u_c; 

      // PSIM Realistic Plant Model: Vin - IL*RL - Vd*(1-d) - Vout*(1-d) = L*di/dt
      const VL    = Vin - iL[ph]*PHY.RL - (1-d)*PHY.Vd - (1-d)*Vout;
      const diL_n = VL / PHY.L;
      iL[ph] = clamp(iL[ph] + dt * 0.5 * (diL_n + diL_p[ph]), 0, I_MAG_MAX * 2.5);
      diL_p[ph] = diL_n;
      
      i_cap += iL[ph] * (1 - d);
      p_loss += iL[ph]*iL[ph]*PHY.RL + iL[ph]*(1-d)*PHY.Vd;
    }

    // Output Capacitor with ESR: Vout_cap = Vc + i_cap*RC
    const i_load_actual = Vout / R;
    const dV_n = (i_cap - i_load_actual) / PHY.C;
    Vout = Math.max(200, Vout + dt * 0.5 * (dV_n + dV_p));
    dV_p = dV_n;
    
    // Real Vout (including ESR drop)
    const Vout_real_log = Vout + (i_cap - i_load_actual) * PHY.RC;

    if (n % skip === 0) {
      rec.t.push(+(t * 1000).toFixed(4));
      rec.vout.push(+Vout_real_log.toFixed(3));

      rec.vin.push(+Vin.toFixed(3));
      rec.iac.push(+((iL[0] + iL[1] + iL[2]) * sv).toFixed(4));
      rec.iref.push(+Iref.toFixed(4));
      for (let ph = 0; ph < 3; ph++) rec.il[ph].push(+iL[ph].toFixed(4));
    }
  }
  return { ...rec, metrics: calcMetrics(rec) };
}

function calcMetrics(rec: any) {
  const N = rec.t.length;
  const ss = Math.floor(N * 0.65);
  const vss = rec.vout.slice(ss);
  const Va = vss.reduce((a: number, b: number) => a + b, 0) / vss.length;
  const ripple = ((Math.max(...vss) - Math.min(...vss)) / Va) * 100;

  let settling = rec.t[N - 1];
  const band = Va * 0.02;
  for (let i = 10; i < N - 20; i++) {
    if (rec.vout.slice(i, i + 20).every((v: number) => Math.abs(v - Va) < band)) {
      settling = rec.t[i]; break;
    }
  }

  const dt_rec = (rec.t[N-1] - rec.t[0]) / (N - 1) / 1000; 
  const spc    = Math.round(1 / (PHY.f_ac * dt_rec));        
  const nc     = Math.max(1, Math.min(3, Math.floor((N - ss) / spc)));
  const M      = spc * nc;
  const iac_w  = rec.iac.slice(rec.iac.length - M);
  let fund = 0.001, harm = 0;
  for (let k = 1; k <= 13; k++) {
    let re = 0, im = 0;
    for (let n = 0; n < M; n++) {
      const a = 2 * Math.PI * k * nc * n / M;
      re += iac_w[n] * Math.cos(a);
      im -= iac_w[n] * Math.sin(a);
    }
    const mag = 2 * Math.sqrt(re*re + im*im) / M;
    if (k === 1) fund = Math.max(mag, 0.001);
    else harm += mag * mag;
  }
  const THD = Math.min(Math.sqrt(harm) / fund * 100, 50);
  const PF  = Math.min(0.999, 1 / Math.sqrt(1 + (THD/100)**2) * 0.998);

  const rms = rec.il.map((ph: any) => {
    const s = ph.slice(ss);
    return Math.sqrt(s.reduce((a: number, b: number) => a + b*b, 0) / s.length);
  });
  const rms_total = Math.sqrt(iac_w.reduce((a: number, b: number) => a + b*b, 0) / iac_w.length);
  const ra  = rms.reduce((a: number, b: number) => a + b, 0) / 3;
  const imb = ra > 0.05 ? (Math.max(...rms) - Math.min(...rms)) / ra * 100 : 0;

  const track = rec.iref.slice(ss).map((r: number, i: number) =>
    Math.abs(r - (rec.il[0][i+ss] + rec.il[1][i+ss] + rec.il[2][i+ss]))).reduce((a: number,b: number)=>a+b,0)/vss.length;

  return {
    Va: +Va.toFixed(2), ripple: +ripple.toFixed(2),
    settling: +settling.toFixed(1), THD: +THD.toFixed(2),
    PF: +PF.toFixed(4), fund: +fund.toFixed(3),
    I_rms_total: +rms_total.toFixed(3),
    rms: rms.map((v: number) => +v.toFixed(3)), imb: +imb.toFixed(2),
    track: +track.toFixed(4), spc, nc, M,
    ok_V:   Math.abs(Va - 400) <= 5,
    ok_thd: THD <= 10,
    ok_pf:  PF >= 0.98,
    ok_bal: imb <= 3,
    ok:     Math.abs(Va - 400) <= 5 && THD <= 10 && PF >= 0.98 && rms_total < 6.0,
  };
}

// ============================================================
// SYSTEM PROMPTS
// ============================================================
const SYSTEM_PROMPT = `Sen F28004x tabanlı 3-faz interleaved boost PFC kontrol mühendisisin.
ŞEMA DETAYLARI (Görsel 1-5):
- ADC: A0=Vout, A1=Vin, A2=IL1, A3=IL2, A4=IL3.
- PWM: Faz1=0°, Faz2=120°, Faz3=240°.
- Devre: 230Vrms, L=400µH, C=820µF, fsw=100kHz.
- Kayıplar: RL=50mΩ, RC=20mΩ, Vd=0.8V.

TEORİK HEDEFLER:
- Iout=2.5A, Pout=1000W, Iin_rms≈4.8A.
- I_mag (faz başına peak) ≈ 2.27A olmalı.

KRİTİK ANALİZ:
1. I_rms_total değerini 4.8A hedefine yaklaştır.
2. Faz kaymalarını (120/240°) dikkate alarak THD ve ripple optimizasyonu yap.
3. Vout=400V ± 5V kararlılığını koru.

YANIT FORMATI: Sadece JSON döndür.
{"B0":0.0,"B1":0.0,"B2":0.0,"A1":-1.0,"A2":0.0,"KP_V":0.0,"KI_V":0.0,"V_INT_MAX":0.0,"I_MAG_MAX":0.0,"SOFTSTART_TIME":0.04,"DUTY_MAX":0.92,"DUTY_MIN":0.01}`;

const GEMINI_CRITIC_PROMPT = `Sen bağımsız bir PFC kontrol mühendisisin. Claude'un önerdiği parametreleri eleştir ve kendi optimize edilmiş parametrelerini sun.
B0 > 0.13 YASAK. KP_V < 0.3 tut.
Sadece JSON döndür.`;

// ============================================================
// UI COMPONENTS
// ============================================================

function OScope({ data, height=160, onZoom }: any) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!data || !ref.current) return;
    const cv = ref.current, ctx = cv.getContext("2d");
    if (!ctx) return;
    const W = cv.width, H = cv.height;
    ctx.fillStyle="#000a02"; ctx.fillRect(0,0,W,H);
    for(let y=0;y<H;y+=3){ctx.fillStyle="rgba(0,0,0,0.12)";ctx.fillRect(0,y,W,1);}
    ctx.strokeStyle="rgba(0,255,100,0.07)";ctx.lineWidth=1;
    for(let g=0;g<=10;g++){ctx.beginPath();ctx.moveTo(g*W/10,0);ctx.lineTo(g*W/10,H);ctx.stroke();}
    for(let g=0;g<=8;g++){ctx.beginPath();ctx.moveTo(0,g*H/8);ctx.lineTo(W,g*H/8);ctx.stroke();}
    const drawL=(arr: any,color: string,lo: number,hi: number,lw=1.5,glow=false)=>{
      if(!arr?.length)return;
      if(glow){ctx.shadowColor=color;ctx.shadowBlur=6;}
      ctx.strokeStyle=color;ctx.lineWidth=lw;ctx.beginPath();
      arr.forEach((v: number,i: number)=>{const x=i/(arr.length-1)*W;const y=H-((v-lo)/(hi-lo+0.001))*H*0.82-H*0.06;i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);});
      ctx.stroke();ctx.shadowBlur=0;
    };
    const vm=Math.max(...data.vout)*1.08||450;
    ctx.setLineDash([4,4]);drawL(data.vout.map(()=>400),"rgba(255,50,50,0.4)",0,vm,1);ctx.setLineDash([]);
    drawL(data.vout,"#00ff64",0,vm,2,true);
    const im=Math.max(...data.il[0],...data.il[1],...data.il[2])*1.2||1;
    drawL(data.il[0],"rgba(255,160,50,0.85)",0,im*3.5,1.5);
    drawL(data.il[1],"rgba(50,220,255,0.85)",0,im*3.5,1.5);
    drawL(data.il[2],"rgba(255,80,200,0.85)",0,im*3.5,1.5);
    ctx.font="bold 10px 'JetBrains Mono'";ctx.shadowColor="#00ff64";ctx.shadowBlur=3;
    ctx.fillStyle="#00ff64";ctx.fillText("Vout",4,13);ctx.shadowBlur=0;
    ctx.font="9px 'JetBrains Mono'";
    ctx.fillStyle="rgba(255,50,50,0.7)";ctx.fillText("400V",4,23);
    ctx.fillStyle="rgba(255,160,50,0.9)";ctx.fillText("IL1",4,H-22);
    ctx.fillStyle="rgba(50,220,255,0.9)";ctx.fillText("IL2",28,H-22);
    ctx.fillStyle="rgba(255,80,200,0.9)";ctx.fillText("IL3",54,H-22);
  },[data]);
  return(
    <div onClick={onZoom} className="bg-[#000a02] rounded-lg border border-emerald-500/10 overflow-hidden relative cursor-zoom-in hover:border-emerald-500/40 transition-colors">
      <div className="absolute top-2 left-2 text-[8px] text-emerald-500/30 font-mono z-10">OSCILLOSCOPE</div>
      <canvas ref={ref} width={480} height={height} className="w-full block" />
    </div>
  );
}

function PFScope({ data, height=120, onZoom }: any) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if(!data||!ref.current)return;
    const cv=ref.current,ctx=cv.getContext("2d");
    if (!ctx) return;
    const W=cv.width,H=cv.height;
    ctx.fillStyle="#000a02";ctx.fillRect(0,0,W,H);
    for(let y=0;y<H;y+=3){ctx.fillStyle="rgba(0,0,0,0.12)";ctx.fillRect(0,y,W,1);}
    ctx.strokeStyle="rgba(0,255,100,0.06)";ctx.lineWidth=1;
    for(let g=0;g<=8;g++){ctx.beginPath();ctx.moveTo(g*W/8,0);ctx.lineTo(g*W/8,H);ctx.stroke();}
    for(let g=0;g<=4;g++){ctx.beginPath();ctx.moveTo(0,g*H/4);ctx.lineTo(W,g*H/4);ctx.stroke();}
    ctx.strokeStyle="rgba(0,255,100,0.1)";ctx.beginPath();ctx.moveTo(0,H/2);ctx.lineTo(W,H/2);ctx.stroke();
    const ss=Math.floor(data.t.length*0.65);
    const iac=data.iac?.slice(ss)||[];
    const t_ss=data.t.slice(ss);
    const N=Math.min(iac.length,300);
    if(N<10)return;
    const vin_ac=t_ss.slice(0,N).map((t: number)=>PHY.Vpeak*Math.sin(2*Math.PI*PHY.f_ac*t/1000));
    const imax=Math.max(...iac.slice(0,N).map(Math.abs))*1.2||1;
    const vmax=PHY.Vpeak*1.1;
    const drawAC=(arr: any,max: number,color: string,lw=1.5,glow=false)=>{
      if(glow){ctx.shadowColor=color;ctx.shadowBlur=5;}
      ctx.strokeStyle=color;ctx.lineWidth=lw;ctx.beginPath();
      arr.slice(0,N).forEach((v: number,i: number)=>{const x=i/(N-1)*W;const y=H/2-(v/max*H*0.42);i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);});
      ctx.stroke();ctx.shadowBlur=0;
    };
    drawAC(vin_ac,vmax,"rgba(255,200,50,0.55)",1.5);
    drawAC(iac,imax,"#00ff64",2,true);
    ctx.font="9px 'JetBrains Mono'";
    ctx.fillStyle="rgba(255,200,50,0.7)";ctx.fillText("Vin_ac",4,12);
    ctx.shadowColor="#00ff64";ctx.shadowBlur=3;
    ctx.fillStyle="#00ff64";ctx.fillText("I_ac",4,22);ctx.shadowBlur=0;
  },[data]);
  return(
    <div onClick={onZoom} className="bg-[#000a02] rounded-lg border border-emerald-500/10 overflow-hidden relative cursor-zoom-in hover:border-emerald-500/40 transition-colors">
      <div className="absolute top-2 left-2 text-[8px] text-emerald-500/30 font-mono z-10">PHASE ANALYSIS</div>
      <canvas ref={ref} width={480} height={height} className="w-full block" />
    </div>
  );
}

function Gauge({label,value,unit,ok,warn,note}: any){
  const c = ok ? "#10b981" : warn ? "#f59e0b" : "#ef4444";
  const bg = ok ? "bg-emerald-500/5" : warn ? "bg-amber-500/5" : "bg-red-500/5";
  const border = ok ? "border-emerald-500/20" : warn ? "border-amber-500/20" : "border-red-500/20";
  
  return(
    <div className={`${bg} ${border} border rounded-2xl p-4 flex flex-col justify-between transition-all hover:scale-[1.02] hover:shadow-lg hover:shadow-emerald-500/5`}>
      <div className="flex justify-between items-start">
        <span className="text-[10px] text-emerald-500/40 font-bold uppercase tracking-widest">{label}</span>
        <div className={`px-2 py-0.5 rounded-full text-[8px] font-bold uppercase tracking-tighter ${ok ? "bg-emerald-500/20 text-emerald-400" : warn ? "bg-amber-500/20 text-amber-400" : "bg-red-500/20 text-red-400"}`}>
          {ok ? "OPTIMAL" : warn ? "WARNING" : "CRITICAL"}
        </div>
      </div>
      <div className="mt-4 flex items-baseline gap-1.5">
        <span className="text-3xl font-mono font-bold tracking-tighter" style={{ color: c, textShadow: `0 0 20px ${c}33` }}>{value}</span>
        <span className="text-[11px] text-emerald-500/30 font-mono font-bold uppercase">{unit}</span>
      </div>
      {note && <div className="mt-2 text-[9px] text-emerald-500/20 font-mono italic border-t border-emerald-500/5 pt-2">{note}</div>}
    </div>
  );
}

// ============================================================
// C BLOCK KOD ÜRETİCİ
// ============================================================
function genCBlock(p: any, iter: number) {
  const fc_est = (p.B0 * PHY.Vout_ref / (PHY.L * 2 * Math.PI)).toFixed(0);
  return `// =================================================================
// F28004x 3-FAZ INTERLEAVED PFC — ITER #${String(iter).padStart(3,'0')}
// ADC MAPPING: A0=Vout, A1=Vin, A2=IL1, A3=IL2, A4=IL3
// PWM PHASING: FAZ1=0°, FAZ2=120°, FAZ3=240°
// fc_i ≈ ${fc_est}Hz
// =================================================================
#include "F28x_Project.h"

#define Ts              5e-7f
#define VDC_TARGET      400.0f

// ADC 12-bit (0-4095) -> 3.3V Dönüşüm Çarpanı
#define ADC_VREF        3.3f
#define ADC_MAX         4095.0f
#define ADC_TO_PIN_V    (ADC_VREF / ADC_MAX)

// Sensör Kazançları (K)
#define K_VDC           0.005f
#define K_VAC           0.006f
#define K_IL            0.3f

// Voltaj Döngüsü PI Katsayıları
#define KP_V ${p.KP_V.toFixed(6)}f
#define KI_V ${p.KI_V.toFixed(6)}f

// 2P2Z Akım Kontrol Katsayıları
#define B0   ${p.B0.toFixed(6)}f
#define B1   ${p.B1.toFixed(6)}f
#define B2   ${p.B2.toFixed(6)}f
#define A1   ${p.A1.toFixed(6)}f
#define A2   ${p.A2.toFixed(6)}f

// Limitler
#define V_INT_MAX       ${p.V_INT_MAX.toFixed(2)}f
#define I_MAG_MAX       ${p.I_MAG_MAX.toFixed(2)}f
#define DUTY_MAX        ${p.DUTY_MAX.toFixed(3)}f
#define DUTY_MIN        ${p.DUTY_MIN.toFixed(3)}f

// Global Değişkenler
float v_err = 0, v_int = 0, i_ref_mag = 0;
float e_il1[3] = {0,0,0}, u_il1[3] = {0,0,0};
float e_il2[3] = {0,0,0}, u_il2[3] = {0,0,0};
float e_il3[3] = {0,0,0}, u_il3[3] = {0,0,0};

// Kesme Fonksiyonu (100kHz'de çalışır)
__interrupt void run_PFC_Control(void) {
    // 1. ADC'den 12-bit ham veriyi (0-4095) oku ve Pin Voltajına (0-3.3V) çevir
    float pin_vout = AdcRegs.ADCRESULT0 * ADC_TO_PIN_V;
    float pin_vin  = AdcRegs.ADCRESULT1 * ADC_TO_PIN_V;
    float pin_il1  = AdcRegs.ADCRESULT2 * ADC_TO_PIN_V;
    float pin_il2  = AdcRegs.ADCRESULT3 * ADC_TO_PIN_V;
    float pin_il3  = AdcRegs.ADCRESULT4 * ADC_TO_PIN_V;

    // (Limiter bloğunun yazılımsal karşılığı - Güvenlik için)
    if(pin_vout > 3.3f) pin_vout = 3.3f;
    if(pin_vin > 3.3f)  pin_vin = 3.3f;
    if(pin_il1 > 3.3f)  pin_il1 = 3.3f;
    if(pin_il2 > 3.3f)  pin_il2 = 3.3f;
    if(pin_il3 > 3.3f)  pin_il3 = 3.3f;

    // 2. Sensör Kazançlarını (K) kullanarak gerçek fiziksel değerlere (V, A) dönüştür
    float vout = pin_vout / K_VDC;
    float vin  = pin_vin  / K_VAC;
    float il1  = pin_il1  / K_IL;
    float il2  = pin_il2  / K_IL;
    float il3  = pin_il3  / K_IL;
    
    // 3. Voltaj Döngüsü (PI Kontrolör)
    v_err = VDC_TARGET - vout;
    v_int += KI_V * v_err * Ts;
    
    // Anti-windup
    if(v_int > V_INT_MAX) v_int = V_INT_MAX;
    if(v_int < 0.0f) v_int = 0.0f;
    
    i_ref_mag = (KP_V * v_err) + v_int;
    if(i_ref_mag > I_MAG_MAX) i_ref_mag = I_MAG_MAX;
    if(i_ref_mag < 0.0f) i_ref_mag = 0.0f;

    // 4. Akım Referansı Üretimi (Şebeke voltajı ile senkronize)
    // Basitleştirilmiş modelde vin doğrudan referans şekli olarak kullanılır
    float i_ref = i_ref_mag * (vin / 325.27f); 
    
    // 5. Akım Döngüleri (2P2Z Kontrolörler) - Her faz için ayrı
    // Faz 1
    e_il1[0] = i_ref - il1;
    u_il1[0] = B0*e_il1[0] + B1*e_il1[1] + B2*e_il1[2] + A1*u_il1[1] + A2*u_il1[2];
    
    // Faz 2
    e_il2[0] = i_ref - il2;
    u_il2[0] = B0*e_il2[0] + B1*e_il2[1] + B2*e_il2[2] + A1*u_il2[1] + A2*u_il2[2];
    
    // Faz 3
    e_il3[0] = i_ref - il3;
    u_il3[0] = B0*e_il3[0] + B1*e_il3[1] + B2*e_il3[2] + A1*u_il3[1] + A2*u_il3[2];

    // 6. Duty Cycle Hesaplama ve Sınırlandırma
    float duty1 = 1.0f - (u_il1[0] / vout);
    float duty2 = 1.0f - (u_il2[0] / vout);
    float duty3 = 1.0f - (u_il3[0] / vout);

    if(duty1 > DUTY_MAX) duty1 = DUTY_MAX;
    if(duty1 < DUTY_MIN) duty1 = DUTY_MIN;
    if(duty2 > DUTY_MAX) duty2 = DUTY_MAX;
    if(duty2 < DUTY_MIN) duty2 = DUTY_MIN;
    if(duty3 > DUTY_MAX) duty3 = DUTY_MAX;
    if(duty3 < DUTY_MIN) duty3 = DUTY_MIN;

    // 7. PWM Kayıtlarını Güncelle (EPwm1, EPwm2, EPwm3)
    // Örnek: TBPRD = 1000 (100kHz için)
    EPwm1Regs.CMPA.bit.CMPA = (uint16_t)(duty1 * 1000.0f);
    EPwm2Regs.CMPA.bit.CMPA = (uint16_t)(duty2 * 1000.0f);
    EPwm3Regs.CMPA.bit.CMPA = (uint16_t)(duty3 * 1000.0f);

    // 8. Geçmiş Değerleri Güncelle
    e_il1[2] = e_il1[1]; e_il1[1] = e_il1[0];
    u_il1[2] = u_il1[1]; u_il1[1] = u_il1[0];
    
    e_il2[2] = e_il2[1]; e_il2[1] = e_il2[0];
    u_il2[2] = u_il2[1]; u_il2[1] = u_il2[0];
    
    e_il3[2] = e_il3[1]; e_il3[1] = e_il3[0];
    u_il3[2] = u_il3[1]; u_il3[1] = u_il3[0];

    // ADC Kesme Bayrağını Temizle
    AdcRegs.ADCINTFLGCLR.bit.ADCINT1 = 1;
    PieCtrlRegs.PIEACK.all = PIEACK_GROUP1;
}
`;
}

// ============================================================
// MAIN APPLICATION
// ============================================================

export default function App() {
  const [iters, setIters] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState("");
  const [bestIdx, setBestIdx] = useState<number | null>(null);
  const [selIdx, setSelIdx] = useState<number | null>(null);
  const [gZoom, setGZoom] = useState<any>(null);
  const [maxIter, setMaxIter] = useState(10);
  const [aiMode, setAiMode] = useState("gemini"); // "gemini" | "dual"
  const [modal, setModal] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const abortRef = useRef(false);
  const histRef = useRef<any[]>([]);
  const lastPRef = useRef<any>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  const ai = useMemo(() => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" }), []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const addLog = (msg: string, type: string = "info") => {
    setLogs(p => [...p, { msg, type, ts: new Date().toLocaleTimeString() }]);
  };

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  const scoreIt = (m: any) => {
    if (!m) return 0;
    const t = (m.THD || 0) <= 5 ? 50 : (m.THD || 0) <= 10 ? 40 : (m.THD || 0) <= 15 ? 25 : Math.max(0, 25 - (m.THD || 0));
    const v = Math.abs((m.Va || 0) - 400) <= 4 ? 25 : Math.abs((m.Va || 0) - 400) <= 8 ? 18 : Math.max(0, 18 - Math.abs((m.Va || 0) - 400));
    const p = (m.PF || 0) >= 0.99 ? 15 : (m.PF || 0) >= 0.97 ? 10 : Math.max(0, ((m.PF || 0) - 0.9) * 100);
    const b = (m.imb || 0) <= 3 ? 5 : Math.max(0, 5 - (m.imb || 0) * 0.5);
    return Math.round(t + v + p + b);
  };

  const callGemini = async (prompt: string, instruction: string, logFn?: any) => {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: prompt,
        config: {
          systemInstruction: instruction,
          responseMimeType: "application/json",
        }
      });
      return response.text;
    } catch (e: any) {
      if (e.message?.toLowerCase().includes("quota") || e.message?.includes("429")) {
        return "QUOTA_EXCEEDED";
      }
      logFn?.(`🔴 AI Error: ${e.message}`, "warn");
      return null;
    }
  };

  const runLoop = async (initP: any, startI: number, fresh: boolean) => {
    setRunning(true);
    abortRef.current = false;
    if (fresh) {
      setIters([]);
      setLogs([]);
      setBestIdx(null);
      setSelIdx(null);
      histRef.current = [];
      addLog("⚡ PFC OPTIMIZATION AGENT INITIALIZED", "start");
      addLog("📐 Ts=500ns | Bidirectional v_int | Tustin Discretization", "info");
    }

    let p = { ...initP };

    for (let i = 0; i < maxIter; i++) {
      if (abortRef.current) break;
      const iter = startI + i;
      
      addLog(`\n━━ ITERATION #${iter} ━━`, "header");
      
      setPhase("sim");
      addLog("🔄 Running PSIM-compatible simulation...", "sim");
      await sleep(100);
      
      let sim;
      try {
        sim = simulatePFC(p);
      } catch (err: any) {
        addLog(`❌ Simulation Error: ${err.message}`, "error");
        console.error(err);
        setPhase("error");
        setRunning(false);
        break;
      }
      
      const m = sim.metrics;
      addLog(`✅ Vout=${m.Va}V | THD=${m.THD}% | PF=${m.PF}`, "data");

      // Simülasyon sonucunu anında UI'a ekle (API çökse bile kullanıcı sonucu görsün)
      setIters(prev => {
        const cc = genCBlock(p, iter);
        const nx = [...prev, { iter, p: { ...p }, m, sim, cc, ok: m.ok }];
        const best = nx.reduce((b, it, idx) => (scoreIt(it.m) > b.s ? { s: scoreIt(it.m), i: idx } : b), { s: -1, i: 0 });
        setBestIdx(best.i);
        setSelIdx(nx.length - 1);
        return nx;
      });

      setPhase("ai");
      addLog("🧠 AI Analysis & Parameter Tuning...", "ai");
      
      const report = `ITR#${iter} Vout=${m.Va}V THD=${m.THD}% PF=${m.PF} ΔIL=${m.imb}% B0=${p.B0.toFixed(5)}`;
      histRef.current.push({ role: "user", parts: [{ text: report }] });

      const aiResponse = await callGemini(JSON.stringify(histRef.current), SYSTEM_PROMPT, addLog);
      
      if (aiResponse === "QUOTA_EXCEEDED") {
        addLog("⚠️ API KOTASI DOLDU: Lütfen 1-2 dakika bekleyip tekrar deneyin.", "warn");
        setPhase("error");
        setRunning(false);
        break;
      }

      let np = { ...p };

      if (aiResponse) {
        try {
          const pj = JSON.parse(aiResponse);
          np = {
            ...p,
            ...pj,
            B0: Math.min(Math.abs(pj.B0 || p.B0), 0.13),
            B1: pj.B1 ?? -(Math.min(Math.abs(pj.B0 || p.B0), 0.13) * 0.999)
          };
          addLog(`✨ AI suggested B0=${np.B0.toFixed(5)} | KP_V=${np.KP_V.toFixed(4)}`, "success");
        } catch (e) {
          addLog("⚠️ AI Response parsing failed", "warn");
        }
      }

      p = np;
      lastPRef.current = p;
      await sleep(200);
    }
    setPhase("");
    setRunning(false);
  };

  const startFresh = () => {
    setPhase("");
    const b = calcB0(12000);
    runLoop({
      B0: b.B0, B1: b.B1, B2: 0, A1: -1, A2: 0,
      KP_V: 0.08, KI_V: 15, V_INT_MAX: 4, I_MAG_MAX: 4.5,
      SOFTSTART_TIME: 0.04, DUTY_MAX: 0.92, DUTY_MIN: 0.01
    }, 1, true);
  };

  const sel = selIdx !== null ? iters[selIdx] : null;

  return (
    <div className="min-h-screen bg-[#020604] text-emerald-50 font-mono selection:bg-emerald-500/30">
      {/* Header */}
      <header className="border-b border-emerald-500/10 bg-[#020604]/80 backdrop-blur-md sticky top-0 z-50 p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20">
            <Zap className="text-emerald-500" size={20} />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-widest uppercase text-emerald-500">PFC Optimization Agent</h1>
            <p className="text-[10px] text-emerald-500/40">3-Phase Interleaved Boost Control Optimizer</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {bestIdx !== null && (
            <button 
              onClick={() => setModal(iters[bestIdx].cc)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500/10 text-amber-500 border border-amber-500/20 text-[10px] font-bold hover:bg-amber-500/20 transition-all"
            >
              <Terminal size={12} /> VIEW BEST CODE
            </button>
          )}
          <div className="flex items-center gap-2 bg-emerald-950/30 border border-emerald-500/10 rounded-lg p-1">
            <button 
              onClick={() => setAiMode("gemini")}
              className={`px-3 py-1.5 rounded-md text-[10px] transition-all ${aiMode === "gemini" ? "bg-emerald-500 text-black font-bold" : "text-emerald-500/50 hover:text-emerald-500"}`}
            >
              GEMINI PRO
            </button>
            <button 
              onClick={() => setAiMode("dual")}
              className={`px-3 py-1.5 rounded-md text-[10px] transition-all ${aiMode === "dual" ? "bg-emerald-500 text-black font-bold" : "text-emerald-500/50 hover:text-emerald-500"}`}
            >
              DUAL EXPERT
            </button>
          </div>

          <button 
            onClick={running ? () => { abortRef.current = true; } : startFresh}
            className={`flex items-center gap-2 px-6 py-2 rounded-xl font-bold text-xs tracking-widest transition-all ${running ? "bg-red-500/10 text-red-500 border border-red-500/20" : "bg-emerald-500 text-black hover:scale-105 active:scale-95"}`}
          >
            {running ? <Square size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
            {running ? "ABORT" : "START OPTIMIZATION"}
          </button>
        </div>
      </header>

      <main className="flex h-[calc(100vh-73px)] overflow-hidden bg-[#020604]">
        {/* Left Sidebar: Mini Terminal + Iteration List */}
        <aside className="w-80 border-r border-emerald-500/10 flex flex-col bg-[#020604] shrink-0">
          {/* Mini Terminal (Iteration Flow) */}
          <div className="h-1/3 flex flex-col border-b border-emerald-500/10">
            <div className="p-2 px-3 bg-emerald-950/20 border-b border-emerald-500/5 flex items-center justify-between">
              <span className="text-[9px] text-emerald-500/60 font-mono flex items-center gap-1.5">
                <Terminal size={10} /> ITERATION FLOW
              </span>
              <div className="flex items-center gap-2">
                {logs.length > 0 && (
                  <button 
                    onClick={() => setLogs([])}
                    className="text-[8px] text-emerald-500/30 hover:text-emerald-500 font-bold uppercase tracking-tighter transition-colors"
                  >
                    Clear
                  </button>
                )}
                {running && (
                  <motion.div 
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ duration: 1.5, repeat: Infinity }}
                    className="w-1.5 h-1.5 rounded-full bg-emerald-500"
                  />
                )}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1.5 text-[10px] font-mono leading-tight scrollbar-hide bg-black/40">
              {logs.length === 0 && (
                <div className="h-full flex items-center justify-center text-emerald-500/10 text-center p-4">
                  <p>System ready...</p>
                </div>
              )}
              {logs.map((log, i) => (
                <div key={i} className={`flex gap-2 ${log.type === "header" ? "text-emerald-400 font-bold border-t border-emerald-500/10 pt-1 mt-1" : "text-emerald-500/40"}`}>
                  <span className="opacity-30 shrink-0">[{log.ts.split(' ')[0]}]</span>
                  <span className={
                    log.type === "success" ? "text-emerald-400" :
                    log.type === "warn" ? "text-amber-400" :
                    log.type === "data" ? "text-sky-400" :
                    ""
                  }>{log.msg}</span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>

          {/* Iteration History List */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="p-2 px-3 bg-emerald-950/10 border-b border-emerald-500/5 flex items-center justify-between">
              <span className="text-[9px] text-emerald-500/60 font-mono flex items-center gap-1.5">
                <Database size={10} /> HISTORY ({iters.length})
              </span>
              {iters.length > 0 && (
                <button 
                  onClick={() => { setIters([]); setBestIdx(null); setSelIdx(null); }}
                  className="text-[8px] text-red-500/40 hover:text-red-500 font-bold uppercase tracking-tighter transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-2 scrollbar-hide">
              {iters.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-emerald-500/5 text-center p-8">
                  <RefreshCw size={32} className="mb-2 opacity-10 animate-spin-slow" />
                  <p className="text-[10px]">No iterations yet</p>
                </div>
              )}
              {[...iters].reverse().map((it, i) => {
                const idx = iters.length - 1 - i;
                const isBest = idx === bestIdx;
                const isSelected = idx === selIdx;
                return (
                  <motion.div
                    key={it.iter}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    onClick={() => setSelIdx(idx)}
                    className={`p-2.5 rounded-lg border cursor-pointer transition-all ${
                      isSelected 
                        ? "bg-emerald-500/10 border-emerald-500/40 shadow-[0_0_10px_rgba(16,185,129,0.1)]" 
                        : isBest 
                          ? "bg-amber-500/5 border-amber-500/20" 
                          : "bg-emerald-950/5 border-emerald-500/5 hover:border-emerald-500/20"
                    }`}
                  >
                    <div className="flex justify-between items-center mb-1.5">
                      <span className={`text-[9px] font-bold ${isSelected ? "text-emerald-400" : "text-emerald-500/40"}`}>
                        #{String(it.iter).padStart(2, '0')} {isBest && "🏆"}
                      </span>
                      <div className="flex gap-1">
                        <div className={`w-1 h-1 rounded-full ${it.m.ok_thd ? "bg-emerald-500" : "bg-red-500"}`} />
                        <div className={`w-1 h-1 rounded-full ${it.m.ok_V ? "bg-emerald-500" : "bg-red-500"}`} />
                      </div>
                    </div>
                    <div className="flex justify-between text-[9px] font-mono">
                      <span className={it.m?.ok_thd ? "text-emerald-400/80" : "text-red-400/80"}>{it.m?.THD || 0}% THD</span>
                      <span className={it.m?.ok_V ? "text-emerald-400/80" : "text-red-400/80"}>{it.m?.Va || 0}V</span>
                    </div>
                    {isSelected && (
                      <div className="mt-2 pt-2 border-t border-emerald-500/10 flex justify-end">
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            const params = JSON.stringify(it.p, null, 2);
                            navigator.clipboard.writeText(params);
                          }}
                          className="text-[8px] text-emerald-500/60 hover:text-emerald-500 font-bold uppercase tracking-widest flex items-center gap-1 transition-colors"
                        >
                          <Copy size={8} /> Copy Params
                        </button>
                      </div>
                    )}
                  </motion.div>
                );
              })}
            </div>
          </div>
        </aside>

        {/* Main Content: Visuals & Metrics */}
        <section className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-hide">
          {!sel && !running ? (
            <div className="h-full flex flex-col items-center justify-center text-emerald-500/10 space-y-6">
              <div className="relative">
                {phase === "error" ? (
                  <AlertCircle size={80} className="text-red-500/20" />
                ) : (
                  <Activity size={80} className="opacity-5" />
                )}
                <motion.div 
                  animate={{ scale: [1, 1.1, 1], opacity: [0.1, 0.2, 0.1] }}
                  transition={{ duration: 4, repeat: Infinity }}
                  className={`absolute inset-0 rounded-full blur-3xl ${phase === "error" ? "bg-red-500" : "bg-emerald-500"}`}
                />
              </div>
              <div className="text-center space-y-2">
                <h3 className={`text-xl font-bold tracking-[0.2em] ${phase === "error" ? "text-red-500/40" : "text-emerald-500/20"}`}>
                  {phase === "error" ? "API QUOTA EXCEEDED" : "AGENT STANDBY"}
                </h3>
                <p className="text-[10px] tracking-widest uppercase opacity-30">
                  {phase === "error" ? "Please wait 1-2 minutes before retrying" : "Initialize optimization to begin analysis"}
                </p>
              </div>
            </div>
          ) : (
            <AnimatePresence mode="wait">
              <motion.div 
                key={sel?.iter}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="max-w-5xl mx-auto space-y-6"
              >
                {/* Metrics Grid */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <Gauge label="VOLTAGE OUTPUT" value={sel?.m?.Va || 0} unit="V" ok={sel?.m?.ok_V} />
                  <Gauge label="TOTAL RMS CURRENT" value={sel?.m?.I_rms_total || 0} unit="A" ok={sel?.m?.I_rms_total < 6.0} warn={sel?.m?.I_rms_total > 8.0} note="Target ~4.8A" />
                  <Gauge label="TOTAL HARMONIC DIST" value={sel?.m?.THD || 0} unit="%" ok={sel?.m?.ok_thd} note="Target < 10%" />
                  <Gauge label="POWER FACTOR" value={sel?.m?.PF || 0} unit="" ok={sel?.m?.ok_pf} />
                </div>

                {/* Main Charts */}
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between px-1">
                      <span className="text-[10px] text-emerald-500/40 font-bold uppercase tracking-widest flex items-center gap-2">
                        <Activity size={12} /> Transient Waveforms
                      </span>
                      <span className="text-[9px] text-emerald-500/20 font-mono">Vout + Phase Currents</span>
                    </div>
                    <OScope data={sel?.sim} height={220} onZoom={() => setGZoom({data:sel?.sim, title:`Iteration #${sel?.iter} Transient`, type:'scope'})} />
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between px-1">
                      <span className="text-[10px] text-emerald-500/40 font-bold uppercase tracking-widest flex items-center gap-2">
                        <RefreshCw size={12} /> Phase Alignment
                      </span>
                      <span className="text-[9px] text-emerald-500/20 font-mono">I_ac vs Vin_ac</span>
                    </div>
                    <PFScope data={sel?.sim} height={220} onZoom={() => setGZoom({data:sel?.sim, title:`Iteration #${sel?.iter} Phase`, type:'pf'})} />
                  </div>
                </div>

                {/* Parameters & Details */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                  <div className="md:col-span-3 bg-emerald-950/10 border border-emerald-500/5 rounded-2xl p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h4 className="text-[10px] text-emerald-500/50 font-bold uppercase tracking-widest">Optimized Parameters</h4>
                      <div className="flex items-center gap-3">
                        <button 
                          onClick={() => setModal(sel?.cc)}
                          className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 text-[9px] font-bold uppercase hover:bg-emerald-500/20 transition-all"
                        >
                          <Terminal size={10} /> View C Code
                        </button>
                        <span className="text-[9px] text-emerald-500/20 font-mono">Iteration #{sel?.iter}</span>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
                      {[
                        ["B0 (Gain)", sel?.p.B0.toFixed(6)],
                        ["KP_V", sel?.p.KP_V.toFixed(4)],
                        ["KI_V", sel?.p.KI_V.toFixed(2)],
                        ["I_MAG_MAX", sel?.p.I_MAG_MAX.toFixed(2)],
                        ["B1", sel?.p.B1.toFixed(6)],
                        ["V_INT_MAX", sel?.p.V_INT_MAX.toFixed(2)],
                        ["DUTY_MAX", sel?.p.DUTY_MAX.toFixed(3)],
                        ["SOFT_START", sel?.p.SOFTSTART_TIME.toFixed(3)]
                      ].map(([k, v]) => (
                        <div key={k} className="space-y-1">
                          <span className="text-[9px] text-emerald-500/30 uppercase font-mono">{k}</span>
                          <div className="text-sm font-mono font-bold text-emerald-400/90">{v}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-2xl p-5 flex flex-col justify-center items-center text-center space-y-3">
                    <div className="w-12 h-12 rounded-full bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20">
                      <BrainCircuit className="text-emerald-500" size={24} />
                    </div>
                    <div>
                      <div className="text-[10px] text-emerald-500/40 uppercase font-bold mb-1">AI Confidence</div>
                      <div className="text-2xl font-mono font-bold text-emerald-500">{scoreIt(sel?.m)}%</div>
                    </div>
                  </div>
                </div>
              </motion.div>
            </AnimatePresence>
          )}
        </section>
      </main>


      {/* Footer / Status Bar */}
      <footer className="border-t border-emerald-500/10 bg-[#020604] p-2 px-4 flex items-center justify-between text-[9px] text-emerald-500/30">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1"><Cpu size={10} /> CORE: GEMINI-3.1-PRO</span>
          <span className="flex items-center gap-1"><Activity size={10} /> STATUS: {running ? "OPTIMIZING" : "IDLE"}</span>
        </div>
        <div>
          © 2026 PFC OPTIMIZATION AGENT · POWERED BY GOOGLE AI
        </div>
      </footer>

      {/* C BLOCK MODAL */}
      {modal && (
        <div className="fixed inset-0 bg-black/95 flex items-center justify-center z-[100] backdrop-blur-md p-6" onClick={() => setModal(null)}>
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-[#000a02] border border-emerald-500/20 rounded-2xl w-full max-w-3xl max-h-[80vh] overflow-hidden flex flex-col shadow-2xl shadow-emerald-500/10"
            onClick={e => e.stopPropagation()}
          >
            <div className="p-4 border-b border-emerald-500/10 flex justify-between items-center bg-emerald-950/20">
              <span className="text-[10px] text-emerald-500 font-bold uppercase tracking-widest flex items-center gap-2">
                <Terminal size={14} /> PSIM C-BLOCK SOURCE CODE
              </span>
              <div className="flex items-center gap-3">
                <button 
                  onClick={() => {
                    navigator.clipboard.writeText(modal);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                  className="text-[10px] text-emerald-500/60 hover:text-emerald-500 font-bold uppercase tracking-widest flex items-center gap-1.5 transition-colors"
                >
                  {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />} 
                  {copied ? "COPIED!" : "COPY CODE"}
                </button>
                <button onClick={() => setModal(null)} className="text-emerald-500/30 hover:text-emerald-500 transition-colors">
                  <Square size={16} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-6 bg-black/40">
              <pre className="text-[11px] font-mono text-emerald-400/80 leading-relaxed whitespace-pre-wrap">
                {modal}
              </pre>
            </div>
          </motion.div>
        </div>
      )}

      {/* GRAPH ZOOM */}
      {gZoom && (
        <div className="fixed inset-0 bg-black/98 flex items-center justify-center z-[110] backdrop-blur-xl p-8" onClick={() => setGZoom(null)}>
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-full max-w-6xl space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex justify-between items-center">
              <div className="space-y-1">
                <h2 className="text-emerald-500 font-bold tracking-[0.2em] uppercase">{gZoom.title}</h2>
                <p className="text-[10px] text-emerald-500/30 uppercase tracking-widest">High-Resolution Waveform Analysis</p>
              </div>
              <button onClick={() => setGZoom(null)} className="w-10 h-10 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-500 hover:bg-red-500/20 transition-all">
                <Square size={16} fill="currentColor" />
              </button>
            </div>
            <div className="bg-black/60 border border-emerald-500/10 rounded-3xl p-8">
              {gZoom.type === "scope" ? <OScope data={gZoom.data} height={400} /> : <PFScope data={gZoom.data} height={400} />}
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
