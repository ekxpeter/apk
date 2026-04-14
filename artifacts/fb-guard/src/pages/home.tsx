import React, { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Terminal, LogOut, Loader2, KeyRound, Cookie, ShieldCheck, ShieldAlert } from "lucide-react";
import { useFbLogin, useFbLoginCookie, useFbToggleGuard } from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { Separator } from "@/components/ui/separator";

const emailLoginSchema = z.object({
  email: z.string().min(1, { message: "Email or phone is required" }),
  password: z.string().min(1, { message: "Password is required" }),
});

const cookieLoginSchema = z.object({
  cookie: z.string().min(1, { message: "Cookie data is required" }),
});

type AuthState = {
  token: string;
  userId: string;
  name: string;
} | null;

export default function Home() {
  const [auth, setAuth] = useState<AuthState>(null);
  const [guardStatus, setGuardStatus] = useState<{ isShielded: boolean; message: string } | null>(null);
  const { toast } = useToast();

  const loginMutation = useFbLogin();
  const cookieLoginMutation = useFbLoginCookie();
  const toggleGuardMutation = useFbToggleGuard();

  const emailForm = useForm<z.infer<typeof emailLoginSchema>>({
    resolver: zodResolver(emailLoginSchema),
    defaultValues: { email: "", password: "" },
  });

  const cookieForm = useForm<z.infer<typeof cookieLoginSchema>>({
    resolver: zodResolver(cookieLoginSchema),
    defaultValues: { cookie: "" },
  });

  const onEmailSubmit = (values: z.infer<typeof emailLoginSchema>) => {
    loginMutation.mutate({ data: values }, {
      onSuccess: (data) => {
        setAuth({ token: data.token, userId: data.userId, name: data.name });
        setGuardStatus(null);
        toast({
          title: "Access Granted",
          description: `Logged in as ${data.name}`,
        });
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          title: "Access Denied",
          description: err.message || "Failed to authenticate.",
        });
      }
    });
  };

  const onCookieSubmit = (values: z.infer<typeof cookieLoginSchema>) => {
    cookieLoginMutation.mutate({ data: values }, {
      onSuccess: (data) => {
        setAuth({ token: data.token, userId: data.userId, name: data.name });
        setGuardStatus(null);
        toast({
          title: "Access Granted",
          description: `Logged in as ${data.name}`,
        });
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          title: "Access Denied",
          description: err.message || "Failed to authenticate.",
        });
      }
    });
  };

  const handleToggleGuard = (enable: boolean) => {
    if (!auth) return;
    toggleGuardMutation.mutate({ data: { token: auth.token, enable } }, {
      onSuccess: (data) => {
        setGuardStatus({ isShielded: data.isShielded, message: data.message });
        toast({
          title: data.success ? "Protocol Executed" : "Protocol Failed",
          description: data.message,
          variant: data.success ? "default" : "destructive",
        });
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          title: "Protocol Error",
          description: err.message || "Failed to execute guard protocol.",
        });
      }
    });
  };

  const handleLogout = () => {
    setAuth(null);
    setGuardStatus(null);
    emailForm.reset();
    cookieForm.reset();
  };

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center p-4 bg-background overflow-hidden relative selection:bg-primary selection:text-primary-foreground">
      {/* Decorative Matrix-like background scanlines */}
      <div className="pointer-events-none fixed inset-0 opacity-[0.03] z-0" 
           style={{ backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, var(--primary) 2px, var(--primary) 4px)' }}>
      </div>

      <div className="z-10 w-full max-w-md space-y-6">
        <div className="flex flex-col items-center space-y-2 mb-8">
          <div className="w-16 h-16 border-2 border-primary rounded-none flex items-center justify-center bg-background/50 shadow-[0_0_15px_rgba(0,255,0,0.3)]">
            <Terminal className="w-8 h-8 text-primary animate-pulse" />
          </div>
          <h1 className="text-3xl font-bold tracking-tighter uppercase text-primary drop-shadow-[0_0_8px_rgba(0,255,0,0.5)]">
            Vrax::Guard
          </h1>
          <p className="text-sm text-primary/70 tracking-widest uppercase">Profile Defense Subsystem</p>
        </div>

        {!auth ? (
          <Card className="border border-primary/30 shadow-[0_0_30px_rgba(0,255,0,0.05)] bg-card/80 backdrop-blur-sm rounded-none">
            <CardHeader className="border-b border-primary/20 pb-4">
              <CardTitle className="text-xl uppercase tracking-wider font-mono">Authentication</CardTitle>
              <CardDescription className="text-primary/60 font-mono text-xs">
                Provide credentials to access defense controls.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              <Tabs defaultValue="email" className="w-full">
                <TabsList className="grid w-full grid-cols-2 rounded-none bg-background border border-primary/20 p-0 h-12">
                  <TabsTrigger 
                    value="email" 
                    className="rounded-none h-full data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary font-mono text-xs uppercase"
                  >
                    <KeyRound className="w-4 h-4 mr-2" />
                    Standard
                  </TabsTrigger>
                  <TabsTrigger 
                    value="cookie"
                    className="rounded-none h-full data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary font-mono text-xs uppercase"
                  >
                    <Cookie className="w-4 h-4 mr-2" />
                    Session
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="email" className="pt-4">
                  <Form {...emailForm}>
                    <form onSubmit={emailForm.handleSubmit(onEmailSubmit)} className="space-y-4">
                      <FormField
                        control={emailForm.control}
                        name="email"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="uppercase text-xs tracking-wider text-primary/80">Target ID (Email/Phone)</FormLabel>
                            <FormControl>
                              <Input 
                                placeholder="target@domain.com" 
                                className="rounded-none border-primary/30 focus-visible:ring-primary/50 font-mono bg-background" 
                                {...field} 
                              />
                            </FormControl>
                            <FormMessage className="text-destructive font-mono text-xs" />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={emailForm.control}
                        name="password"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="uppercase text-xs tracking-wider text-primary/80">Passkey</FormLabel>
                            <FormControl>
                              <Input 
                                type="password" 
                                placeholder="••••••••" 
                                className="rounded-none border-primary/30 focus-visible:ring-primary/50 font-mono bg-background" 
                                {...field} 
                              />
                            </FormControl>
                            <FormMessage className="text-destructive font-mono text-xs" />
                          </FormItem>
                        )}
                      />
                      <Button 
                        type="submit" 
                        className="w-full rounded-none font-mono uppercase tracking-wider h-12"
                        disabled={loginMutation.isPending}
                      >
                        {loginMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Terminal className="w-4 h-4 mr-2" />}
                        {loginMutation.isPending ? "Connecting..." : "Initiate Uplink"}
                      </Button>
                    </form>
                  </Form>
                </TabsContent>

                <TabsContent value="cookie" className="pt-4">
                  <Form {...cookieForm}>
                    <form onSubmit={cookieForm.handleSubmit(onCookieSubmit)} className="space-y-4">
                      <FormField
                        control={cookieForm.control}
                        name="cookie"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="uppercase text-xs tracking-wider text-primary/80">Session Data (c_user, xs, etc)</FormLabel>
                            <FormControl>
                              <Input 
                                placeholder="c_user=123; xs=ABC;" 
                                className="rounded-none border-primary/30 focus-visible:ring-primary/50 font-mono bg-background" 
                                {...field} 
                              />
                            </FormControl>
                            <FormMessage className="text-destructive font-mono text-xs" />
                          </FormItem>
                        )}
                      />
                      <Button 
                        type="submit" 
                        className="w-full rounded-none font-mono uppercase tracking-wider h-12"
                        disabled={cookieLoginMutation.isPending}
                      >
                        {cookieLoginMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Terminal className="w-4 h-4 mr-2" />}
                        {cookieLoginMutation.isPending ? "Connecting..." : "Inject Session"}
                      </Button>
                    </form>
                  </Form>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6 animate-in fade-in zoom-in duration-300">
            <Card className="border border-primary shadow-[0_0_20px_rgba(0,255,0,0.1)] bg-card/80 backdrop-blur-sm rounded-none">
              <CardHeader className="border-b border-primary/30 pb-4 flex flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle className="text-xl uppercase tracking-wider font-mono">Terminal Active</CardTitle>
                  <CardDescription className="text-primary/60 font-mono text-xs mt-1">
                    System connected
                  </CardDescription>
                </div>
                <Button 
                  variant="outline" 
                  size="icon" 
                  onClick={handleLogout}
                  className="rounded-none border-primary/30 hover:bg-destructive/20 hover:text-destructive hover:border-destructive transition-colors"
                  title="Terminate Connection"
                >
                  <LogOut className="w-4 h-4" />
                </Button>
              </CardHeader>
              <CardContent className="pt-6 space-y-6">
                <div className="grid grid-cols-2 gap-4 text-sm font-mono">
                  <div className="space-y-1">
                    <span className="text-primary/50 uppercase text-xs">Target Name</span>
                    <p className="font-semibold truncate">{auth.name}</p>
                  </div>
                  <div className="space-y-1">
                    <span className="text-primary/50 uppercase text-xs">Target UID</span>
                    <p className="font-semibold truncate">{auth.userId}</p>
                  </div>
                </div>

                <Separator className="bg-primary/20" />

                {guardStatus && (
                  <Alert variant={guardStatus.isShielded ? "default" : "destructive"} className="rounded-none bg-background/50 border-primary/50">
                    {guardStatus.isShielded ? (
                      <ShieldCheck className="w-4 h-4 text-primary" />
                    ) : (
                      <ShieldAlert className="w-4 h-4 text-destructive" />
                    )}
                    <AlertTitle className="uppercase font-mono tracking-wider">
                      Status Update
                    </AlertTitle>
                    <AlertDescription className="font-mono text-xs">
                      {guardStatus.message}
                    </AlertDescription>
                  </Alert>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <Button
                    onClick={() => handleToggleGuard(true)}
                    disabled={toggleGuardMutation.isPending}
                    className="rounded-none h-14 font-mono uppercase tracking-wider bg-primary/20 hover:bg-primary/40 border border-primary text-primary"
                  >
                    {toggleGuardMutation.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <ShieldCheck className="w-4 h-4 mr-2" />
                    )}
                    Engage
                  </Button>
                  <Button
                    onClick={() => handleToggleGuard(false)}
                    disabled={toggleGuardMutation.isPending}
                    variant="destructive"
                    className="rounded-none h-14 font-mono uppercase tracking-wider bg-destructive/20 hover:bg-destructive/40 border border-destructive text-destructive"
                  >
                    {toggleGuardMutation.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <ShieldAlert className="w-4 h-4 mr-2" />
                    )}
                    Disengage
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        <div className="text-center">
          <p className="text-[10px] font-mono text-primary/40 tracking-widest">
            VRAX :: SECURE SYSTEMS :: v1.0.0
          </p>
        </div>
      </div>
    </div>
  );
}
