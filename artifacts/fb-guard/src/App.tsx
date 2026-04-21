import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import NotFound from "@/pages/not-found";
import Login from "@/pages/login";
import Register from "@/pages/register";
import Dashboard from "@/pages/dashboard";
import SplashIntro from "@/components/SplashIntro";
import { apiFetch } from "@/lib/api";
import { getLocalSession } from "@/lib/localAuth";

const queryClient = new QueryClient();

function AuthRedirect() {
  const [, navigate] = useLocation();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let done = false;
    const finish = (path: string) => {
      if (done) return;
      done = true;
      setChecking(false);
      navigate(path);
    };

    const timeout = setTimeout(() => {
      const local = getLocalSession();
      finish(local ? "/dashboard" : "/login");
    }, 3500);

    apiFetch("/api/auth/me", { credentials: "include" })
      .then((r) => {
        clearTimeout(timeout);
        if (r.ok) finish("/dashboard");
        else {
          const local = getLocalSession();
          finish(local ? "/dashboard" : "/login");
        }
      })
      .catch(() => {
        clearTimeout(timeout);
        const local = getLocalSession();
        finish(local ? "/dashboard" : "/login");
      });

    return () => clearTimeout(timeout);
  }, []);

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#1877F2] to-[#0D47A1]">
        <Loader2 className="w-8 h-8 text-white animate-spin" />
      </div>
    );
  }
  return null;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={AuthRedirect} />
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      <Route path="/dashboard" component={Dashboard} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const [showSplash, setShowSplash] = useState(() => {
    if (typeof window === "undefined") return false;
    return !sessionStorage.getItem("fbg_splash_shown");
  });

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {showSplash && (
          <SplashIntro
            onDone={() => {
              sessionStorage.setItem("fbg_splash_shown", "1");
              setShowSplash(false);
            }}
          />
        )}
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
