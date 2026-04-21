import { useEffect, useState } from "react";
import { Facebook, Shield } from "lucide-react";

export default function SplashIntro({ onDone }: { onDone: () => void }) {
  const [progress, setProgress] = useState(0);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const total = 1800;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / total);
      setProgress(p);
      if (p < 1) raf = requestAnimationFrame(tick);
      else {
        setExiting(true);
        setTimeout(onDone, 350);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [onDone]);

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-gradient-to-br from-[#1877F2] via-[#1565C0] to-[#0D47A1] transition-opacity duration-300 ${
        exiting ? "opacity-0" : "opacity-100"
      }`}
    >
      <div className="relative">
        <div className="absolute inset-0 rounded-3xl bg-white/20 blur-2xl animate-pulse" />
        <div className="relative bg-white/10 backdrop-blur-sm rounded-3xl p-6 border border-white/20 shadow-2xl">
          <div className="relative">
            <Facebook className="w-16 h-16 text-white" />
            <Shield
              className="absolute -bottom-1 -right-1 w-7 h-7 text-white drop-shadow-lg"
              fill="currentColor"
            />
          </div>
        </div>
      </div>

      <h1 className="mt-6 text-3xl font-black text-white tracking-tight">Fb Handling</h1>
      <p className="text-white/70 text-sm mt-1">Mass Automation Panel</p>

      <div className="mt-10 w-56 h-1.5 bg-white/15 rounded-full overflow-hidden">
        <div
          className="h-full bg-white rounded-full transition-[width] duration-100 ease-out"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
      <p className="mt-3 text-white/60 text-xs tracking-wider uppercase">
        {progress < 0.5
          ? "Loading"
          : progress < 0.9
          ? "Preparing"
          : "Almost ready"}
      </p>
    </div>
  );
}
