import React, { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ShieldCheck,
  ShieldOff,
  LogOut,
  Loader2,
  KeyRound,
  Cookie,
  Users,
  FileText,
  User,
  Trash2,
  CheckSquare,
  Square,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Shield,
} from "lucide-react";
import {
  useFbLogin,
  useFbLoginCookie,
  useFbToggleGuard,
  useFbGetProfile,
  useFbGetPosts,
  useFbDeletePosts,
} from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";

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

type Post = { id: string; message: string; createdTime: string };
type ProfileInfo = {
  profilePicUrl: string;
  friendsCount: number;
  gender: string;
  postCount: number;
  parsedCookies: Record<string, string>;
};

const FB_BLUE = "#1877F2";

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) {
  return (
    <div className="flex flex-col items-center gap-1 bg-[#F0F2F5] rounded-xl p-3 flex-1">
      <div className="text-[#1877F2]">{icon}</div>
      <span className="text-lg font-bold text-gray-800">{value}</span>
      <span className="text-xs text-gray-500">{label}</span>
    </div>
  );
}

export default function Home() {
  const [auth, setAuth] = useState<AuthState>(null);
  const [guardStatus, setGuardStatus] = useState<{ isShielded: boolean; message: string } | null>(null);
  const [profile, setProfile] = useState<ProfileInfo | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [selectedPosts, setSelectedPosts] = useState<Set<string>>(new Set());
  const [showPosts, setShowPosts] = useState(false);
  const [showCookies, setShowCookies] = useState(false);
  const [imgError, setImgError] = useState(false);
  const { toast } = useToast();

  const loginMutation = useFbLogin();
  const cookieLoginMutation = useFbLoginCookie();
  const toggleGuardMutation = useFbToggleGuard();
  const profileMutation = useFbGetProfile();
  const postsMutation = useFbGetPosts();
  const deletePostsMutation = useFbDeletePosts();

  const emailForm = useForm<z.infer<typeof emailLoginSchema>>({
    resolver: zodResolver(emailLoginSchema),
    defaultValues: { email: "", password: "" },
  });

  const cookieForm = useForm<z.infer<typeof cookieLoginSchema>>({
    resolver: zodResolver(cookieLoginSchema),
    defaultValues: { cookie: "" },
  });

  const onLoginSuccess = (data: { token: string; userId: string; name: string }) => {
    setAuth({ token: data.token, userId: data.userId, name: data.name });
    setGuardStatus(null);
    setProfile(null);
    setPosts([]);
    setSelectedPosts(new Set());
    toast({ title: "Logged in", description: `Welcome, ${data.name}` });
    // Auto-load profile
    setTimeout(() => {
      profileMutation.mutate(
        { data: { token: data.token } },
        {
          onSuccess: (prof) => setProfile(prof),
          onError: () => {},
        }
      );
    }, 100);
  };

  const onEmailSubmit = (values: z.infer<typeof emailLoginSchema>) => {
    loginMutation.mutate({ data: values }, {
      onSuccess: onLoginSuccess,
      onError: (err) => {
        toast({ variant: "destructive", title: "Login failed", description: err.message || "Failed to authenticate." });
      },
    });
  };

  const onCookieSubmit = (values: z.infer<typeof cookieLoginSchema>) => {
    cookieLoginMutation.mutate({ data: values }, {
      onSuccess: onLoginSuccess,
      onError: (err) => {
        toast({ variant: "destructive", title: "Login failed", description: err.message || "Failed to authenticate." });
      },
    });
  };

  const handleToggleGuard = (enable: boolean) => {
    if (!auth) return;
    toggleGuardMutation.mutate({ data: { token: auth.token, enable } }, {
      onSuccess: (data) => {
        setGuardStatus({ isShielded: data.isShielded, message: data.message });
        toast({
          title: data.success ? (enable ? "Profile Guard Enabled" : "Profile Guard Disabled") : "Guard Toggle Failed",
          description: data.message,
          variant: data.success ? "default" : "destructive",
        });
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Error", description: err.message || "Failed to toggle guard." });
      },
    });
  };

  const handleLoadPosts = () => {
    if (!auth) return;
    postsMutation.mutate({ data: { token: auth.token } }, {
      onSuccess: (data) => {
        setPosts(data.posts);
        setShowPosts(true);
        if (data.posts.length === 0) {
          toast({ title: "No posts found", description: "Could not retrieve posts from this account." });
        }
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Error", description: err.message || "Failed to load posts." });
      },
    });
  };

  const handleSelectAll = () => {
    if (selectedPosts.size === posts.length) {
      setSelectedPosts(new Set());
    } else {
      setSelectedPosts(new Set(posts.map((p) => p.id)));
    }
  };

  const handleTogglePost = (id: string) => {
    const next = new Set(selectedPosts);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedPosts(next);
  };

  const handleDeleteSelected = () => {
    if (!auth || selectedPosts.size === 0) return;
    const postIds = Array.from(selectedPosts);
    deletePostsMutation.mutate(
      { data: { token: auth.token, postIds } },
      {
        onSuccess: (result) => {
          toast({
            title: "Delete Complete",
            description: result.message,
            variant: result.failed > 0 ? "destructive" : "default",
          });
          // Remove deleted posts from local list
          setPosts((prev) => prev.filter((p) => !selectedPosts.has(p.id)));
          setSelectedPosts(new Set());
        },
        onError: (err) => {
          toast({ variant: "destructive", title: "Delete failed", description: err.message });
        },
      }
    );
  };

  const handleLogout = () => {
    setAuth(null);
    setGuardStatus(null);
    setProfile(null);
    setPosts([]);
    setSelectedPosts(new Set());
    setShowPosts(false);
    setImgError(false);
    emailForm.reset();
    cookieForm.reset();
  };

  if (!auth) {
    return (
      <div className="min-h-screen bg-[#F0F2F5] flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6">
          {/* Header */}
          <div className="text-center space-y-2">
            <div className="flex items-center justify-center gap-3">
              <div
                className="w-12 h-12 rounded-full flex items-center justify-center"
                style={{ backgroundColor: FB_BLUE }}
              >
                <Shield className="w-7 h-7 text-white" />
              </div>
            </div>
            <h1 className="text-3xl font-bold text-gray-900">Facebook Guard Protection</h1>
            <p className="text-gray-500 text-sm">Protect and manage your Facebook account</p>
          </div>

          {/* Login Card */}
          <Card className="shadow-lg border-0 rounded-2xl overflow-hidden">
            <CardContent className="p-6">
              <Tabs defaultValue="cookie" className="w-full">
                <TabsList className="grid w-full grid-cols-2 mb-6 bg-[#F0F2F5] rounded-xl p-1">
                  <TabsTrigger
                    value="cookie"
                    className="rounded-lg data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-[#1877F2] font-medium"
                  >
                    <Cookie className="w-4 h-4 mr-2" />
                    Cookie Login
                  </TabsTrigger>
                  <TabsTrigger
                    value="email"
                    className="rounded-lg data-[state=active]:bg-white data-[state=active]:shadow-sm data-[state=active]:text-[#1877F2] font-medium"
                  >
                    <KeyRound className="w-4 h-4 mr-2" />
                    Password Login
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="cookie" className="space-y-4">
                  <Form {...cookieForm}>
                    <form onSubmit={cookieForm.handleSubmit(onCookieSubmit)} className="space-y-4">
                      <FormField
                        control={cookieForm.control}
                        name="cookie"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-gray-700 font-medium">Facebook Cookie</FormLabel>
                            <FormControl>
                              <textarea
                                placeholder="Paste your full Facebook cookie string here (c_user=...; xs=...;)"
                                className="w-full min-h-[100px] p-3 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#1877F2] focus:border-transparent resize-none bg-white"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <Button
                        type="submit"
                        className="w-full h-12 text-base font-semibold rounded-xl"
                        style={{ backgroundColor: FB_BLUE }}
                        disabled={cookieLoginMutation.isPending}
                      >
                        {cookieLoginMutation.isPending ? (
                          <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                        ) : (
                          <Cookie className="w-5 h-5 mr-2" />
                        )}
                        {cookieLoginMutation.isPending ? "Connecting..." : "Login with Cookie"}
                      </Button>
                    </form>
                  </Form>
                </TabsContent>

                <TabsContent value="email" className="space-y-4">
                  <Form {...emailForm}>
                    <form onSubmit={emailForm.handleSubmit(onEmailSubmit)} className="space-y-4">
                      <FormField
                        control={emailForm.control}
                        name="email"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-gray-700 font-medium">Email or Phone</FormLabel>
                            <FormControl>
                              <Input
                                placeholder="email@example.com or phone number"
                                className="h-11 rounded-xl border-gray-200 focus-visible:ring-[#1877F2]"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={emailForm.control}
                        name="password"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-gray-700 font-medium">Password</FormLabel>
                            <FormControl>
                              <Input
                                type="password"
                                placeholder="••••••••"
                                className="h-11 rounded-xl border-gray-200 focus-visible:ring-[#1877F2]"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-700">
                        Note: Facebook may block password logins from cloud servers. Use Cookie Login for best results.
                      </div>
                      <Button
                        type="submit"
                        className="w-full h-12 text-base font-semibold rounded-xl"
                        style={{ backgroundColor: FB_BLUE }}
                        disabled={loginMutation.isPending}
                      >
                        {loginMutation.isPending ? (
                          <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                        ) : (
                          <KeyRound className="w-5 h-5 mr-2" />
                        )}
                        {loginMutation.isPending ? "Logging in..." : "Login with Password"}
                      </Button>
                    </form>
                  </Form>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>

          <p className="text-center text-xs text-gray-400">
            Facebook Guard Protection &mdash; Secure account management tool
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F0F2F5] p-4">
      <div className="max-w-2xl mx-auto space-y-4">
        {/* Top bar */}
        <div className="flex items-center justify-between py-2">
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center"
              style={{ backgroundColor: FB_BLUE }}
            >
              <Shield className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-gray-800">Facebook Guard Protection</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleLogout}
            className="rounded-xl border-gray-200 text-gray-600 hover:text-red-600 hover:border-red-200 hover:bg-red-50"
          >
            <LogOut className="w-4 h-4 mr-1" />
            Logout
          </Button>
        </div>

        {/* Profile Card */}
        <Card className="shadow-sm border-0 rounded-2xl overflow-hidden">
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              {/* Profile Picture */}
              <div className="relative flex-shrink-0">
                {profile?.profilePicUrl && !imgError ? (
                  <img
                    src={profile.profilePicUrl}
                    alt="Profile"
                    className="w-20 h-20 rounded-full object-cover border-4 border-white shadow-md"
                    onError={() => setImgError(true)}
                  />
                ) : (
                  <div
                    className="w-20 h-20 rounded-full flex items-center justify-center border-4 border-white shadow-md"
                    style={{ backgroundColor: FB_BLUE }}
                  >
                    <User className="w-10 h-10 text-white" />
                  </div>
                )}
                {guardStatus?.isShielded && (
                  <div className="absolute -bottom-1 -right-1 w-7 h-7 bg-green-500 rounded-full flex items-center justify-center border-2 border-white">
                    <ShieldCheck className="w-4 h-4 text-white" />
                  </div>
                )}
              </div>

              {/* Name & UID */}
              <div className="flex-1 min-w-0">
                <h2 className="text-xl font-bold text-gray-900 truncate">{auth.name}</h2>
                <p className="text-sm text-gray-500 mt-0.5">UID: {auth.userId}</p>
                {profileMutation.isPending && (
                  <div className="flex items-center gap-1 mt-2 text-xs text-[#1877F2]">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Loading profile info...
                  </div>
                )}
                {guardStatus && (
                  <Badge
                    className={`mt-2 text-xs ${guardStatus.isShielded ? "bg-green-100 text-green-700 border-green-200" : "bg-gray-100 text-gray-600 border-gray-200"}`}
                    variant="outline"
                  >
                    {guardStatus.isShielded ? "🛡️ Guard Active" : "Guard Inactive"}
                  </Badge>
                )}
              </div>
            </div>

            {/* Stats Row */}
            {profile && (
              <div className="flex gap-3 mt-5">
                <StatCard
                  icon={<Users className="w-5 h-5" />}
                  label="Friends"
                  value={profile.friendsCount > 0 ? profile.friendsCount.toLocaleString() : "—"}
                />
                <StatCard
                  icon={<User className="w-5 h-5" />}
                  label="Gender"
                  value={profile.gender || "—"}
                />
                <StatCard
                  icon={<FileText className="w-5 h-5" />}
                  label="Posts"
                  value={profile.postCount > 0 ? profile.postCount.toLocaleString() : "—"}
                />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Cookie Info Card */}
        {profile && Object.keys(profile.parsedCookies).length > 0 && (
          <Card className="shadow-sm border-0 rounded-2xl overflow-hidden">
            <CardHeader className="p-4 pb-0">
              <button
                className="flex items-center justify-between w-full text-left"
                onClick={() => setShowCookies((v) => !v)}
              >
                <div className="flex items-center gap-2">
                  <Cookie className="w-4 h-4 text-[#1877F2]" />
                  <CardTitle className="text-sm font-semibold text-gray-700">Cookie Details</CardTitle>
                </div>
                {showCookies ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
              </button>
            </CardHeader>
            {showCookies && (
              <CardContent className="p-4 pt-3">
                <div className="grid grid-cols-1 gap-1 max-h-48 overflow-y-auto">
                  {Object.entries(profile.parsedCookies).map(([key, val]) => (
                    <div key={key} className="flex items-start gap-2 py-1.5 border-b border-gray-100 last:border-0">
                      <span className="text-xs font-semibold text-[#1877F2] w-32 flex-shrink-0 truncate">{key}</span>
                      <span className="text-xs text-gray-600 break-all">{val.length > 60 ? val.slice(0, 60) + "…" : val}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            )}
          </Card>
        )}

        {/* Profile Guard Card */}
        <Card className="shadow-sm border-0 rounded-2xl overflow-hidden">
          <CardContent className="p-6">
            <h3 className="font-semibold text-gray-800 mb-1 flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-[#1877F2]" />
              Profile Guard
            </h3>
            <p className="text-sm text-gray-500 mb-4">
              Enable or disable the Facebook Profile Guard on your account.
            </p>
            {guardStatus && (
              <div
                className={`mb-4 p-3 rounded-xl text-sm ${
                  guardStatus.isShielded
                    ? "bg-green-50 text-green-700 border border-green-200"
                    : "bg-gray-50 text-gray-600 border border-gray-200"
                }`}
              >
                {guardStatus.message}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Button
                onClick={() => handleToggleGuard(true)}
                disabled={toggleGuardMutation.isPending}
                className="h-11 rounded-xl font-semibold"
                style={{ backgroundColor: FB_BLUE }}
              >
                {toggleGuardMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <ShieldCheck className="w-4 h-4 mr-2" />
                )}
                Enable Guard
              </Button>
              <Button
                onClick={() => handleToggleGuard(false)}
                disabled={toggleGuardMutation.isPending}
                variant="outline"
                className="h-11 rounded-xl font-semibold border-gray-200 text-gray-700 hover:bg-gray-50"
              >
                {toggleGuardMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <ShieldOff className="w-4 h-4 mr-2" />
                )}
                Disable Guard
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Posts Management Card */}
        <Card className="shadow-sm border-0 rounded-2xl overflow-hidden">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-semibold text-gray-800 flex items-center gap-2">
                <FileText className="w-5 h-5 text-[#1877F2]" />
                Post Management
              </h3>
              {posts.length > 0 && (
                <span className="text-xs text-gray-400">{posts.length} posts loaded</span>
              )}
            </div>
            <p className="text-sm text-gray-500 mb-4">
              Load and bulk delete your Facebook posts.
            </p>

            <Button
              onClick={handleLoadPosts}
              disabled={postsMutation.isPending}
              variant="outline"
              className="w-full h-11 rounded-xl border-[#1877F2] text-[#1877F2] hover:bg-[#E7F3FF] font-semibold mb-4"
            >
              {postsMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4 mr-2" />
              )}
              {postsMutation.isPending ? "Loading Posts..." : "Load My Posts"}
            </Button>

            {showPosts && posts.length > 0 && (
              <>
                <div className="flex items-center justify-between mb-3">
                  <button
                    onClick={handleSelectAll}
                    className="flex items-center gap-2 text-sm font-medium text-[#1877F2] hover:underline"
                  >
                    {selectedPosts.size === posts.length ? (
                      <CheckSquare className="w-4 h-4" />
                    ) : (
                      <Square className="w-4 h-4" />
                    )}
                    {selectedPosts.size === posts.length ? "Deselect All" : "Select All"}
                  </button>
                  {selectedPosts.size > 0 && (
                    <Button
                      onClick={handleDeleteSelected}
                      disabled={deletePostsMutation.isPending}
                      size="sm"
                      className="rounded-xl h-8 bg-red-500 hover:bg-red-600 text-white text-xs font-semibold"
                    >
                      {deletePostsMutation.isPending ? (
                        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                      ) : (
                        <Trash2 className="w-3 h-3 mr-1" />
                      )}
                      Delete {selectedPosts.size} Selected
                    </Button>
                  )}
                </div>

                <div className="space-y-2 max-h-80 overflow-y-auto">
                  {posts.map((post) => (
                    <div
                      key={post.id}
                      onClick={() => handleTogglePost(post.id)}
                      className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                        selectedPosts.has(post.id)
                          ? "bg-[#E7F3FF] border-[#1877F2]"
                          : "bg-gray-50 border-gray-200 hover:bg-gray-100"
                      }`}
                    >
                      <div className="mt-0.5 flex-shrink-0">
                        {selectedPosts.has(post.id) ? (
                          <CheckSquare className="w-5 h-5 text-[#1877F2]" />
                        ) : (
                          <Square className="w-5 h-5 text-gray-400" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-800 truncate">{post.message}</p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {new Date(post.createdTime).toLocaleDateString()} &middot; ID: {post.id.slice(0, 16)}...
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {showPosts && posts.length === 0 && !postsMutation.isPending && (
              <div className="text-center py-6 text-gray-400 text-sm">
                No posts could be retrieved from this account.
              </div>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-xs text-gray-400 pb-4">
          Facebook Guard Protection &mdash; v2.0
        </p>
      </div>
    </div>
  );
}
