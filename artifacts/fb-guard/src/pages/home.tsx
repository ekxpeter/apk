import React, { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Briefcase,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Cookie,
  Copy,
  Edit3,
  ExternalLink,
  FileText,
  GraduationCap,
  Heart,
  Image,
  KeyRound,
  Link2,
  Loader2,
  LogOut,
  MapPin,
  MessageCircle,
  Moon,
  Play,
  RefreshCw,
  Send,
  Share2,
  Shield,
  ShieldCheck,
  ShieldOff,
  Square,
  Sun,
  Trash2,
  User,
  UserMinus,
  Users,
  Video,
} from "lucide-react";
import {
  useFbCreatePost,
  useFbDeletePosts,
  useFbGetFriends,
  useFbGetPosts,
  useFbGetProfile,
  useFbGetVideos,
  useFbLogin,
  useFbLoginCookie,
  useFbSharePost,
  useFbToggleGuard,
  useFbUnfriend,
  useFbUpdateProfile,
  useFbUpdateProfilePicture,
} from "@workspace/api-client-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";

const emailLoginSchema = z.object({
  email: z.string().min(1, { message: "Email or phone is required" }),
  password: z.string().min(1, { message: "Password is required" }),
});

const cookieLoginSchema = z.object({
  cookie: z.string().min(1, { message: "Cookie data is required" }),
});

const profileEditSchema = z.object({
  name: z.string().optional(),
  bio: z.string().optional(),
  city: z.string().optional(),
  work: z.string().optional(),
  education: z.string().optional(),
  relationship: z.string().optional(),
  website: z.string().optional(),
});

const postSchema = z.object({
  message: z.string().min(1, { message: "Post text is required" }),
  privacy: z.string().optional(),
});

const pfpUrlSchema = z.object({
  imageUrl: z.string().url({ message: "Enter a valid image URL" }),
});

type AuthState = {
  token: string;
  userId: string;
  name: string;
  eaagToken?: string;
} | null;

type Post = { id: string; message: string; createdTime: string; permalink?: string };
type Friend = { id: string; name: string; profileUrl: string; pictureUrl: string };
type VideoItem = {
  id: string;
  title: string;
  thumbnailUrl: string;
  videoUrl: string;
  permalink: string;
  createdTime: string;
};
type ProfileInfo = {
  profilePicUrl: string;
  friendsCount: number;
  gender: string;
  postCount: number;
  parsedCookies: Record<string, string>;
};

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) {
  return (
    <div className="flex flex-1 flex-col items-center gap-1 rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/80">
      <div className="text-[#1877F2]">{icon}</div>
      <span className="text-lg font-bold text-slate-900 dark:text-slate-100">{value}</span>
      <span className="text-xs text-slate-500 dark:text-slate-400">{label}</span>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 py-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
      {text}
    </div>
  );
}

function ThemeToggle({ darkMode, onToggle }: { darkMode: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`relative flex h-10 w-[86px] items-center rounded-full border p-1 transition-all ${
        darkMode ? "border-slate-600 bg-slate-800" : "border-slate-200 bg-white"
      }`}
      aria-label="Toggle dark mode"
    >
      <span
        className={`absolute h-8 w-8 rounded-full shadow-md transition-transform ${
          darkMode ? "translate-x-10 bg-slate-950" : "translate-x-0 bg-[#1877F2]"
        }`}
      />
      <span className="z-10 flex h-8 w-8 items-center justify-center text-white">
        <Sun className="h-4 w-4" />
      </span>
      <span className="z-10 ml-auto flex h-8 w-8 items-center justify-center text-slate-300">
        <Moon className="h-4 w-4" />
      </span>
    </button>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read image file."));
    reader.readAsDataURL(file);
  });
}

export default function Home() {
  const [auth, setAuth] = useState<AuthState>(() => {
    try {
      const saved = localStorage.getItem("fb-guard-auth");
      if (saved) return JSON.parse(saved) as AuthState;
    } catch { /* ignore */ }
    return null;
  });
  const [guardStatus, setGuardStatus] = useState<{ isShielded: boolean; message: string } | null>(null);
  const [profile, setProfile] = useState<ProfileInfo | null>(() => {
    try {
      const saved = localStorage.getItem("fb-guard-profile");
      if (saved) return JSON.parse(saved) as ProfileInfo;
    } catch { /* ignore */ }
    return null;
  });
  const [posts, setPosts] = useState<Post[]>([]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [selectedPosts, setSelectedPosts] = useState<Set<string>>(new Set());
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);
  const [showCookies, setShowCookies] = useState(false);
  const [showToken, setShowToken] = useState(true);
  const [imgError, setImgError] = useState(false);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("fb-guard-theme") === "dark");
  const [unfriendingIds, setUnfriendingIds] = useState<Set<string>>(new Set());
  const [pfpMode, setPfpMode] = useState<"file" | "url">("file");
  const [shareUrl, setShareUrl] = useState("");
  const [shareCount, setShareCount] = useState(10);
  const [shareLogs, setShareLogs] = useState<string[]>([]);
  const [shareResult, setShareResult] = useState<{ success: number; failed: number; message: string } | null>(null);
  const { toast } = useToast();

  const loginMutation = useFbLogin();
  const cookieLoginMutation = useFbLoginCookie();
  const toggleGuardMutation = useFbToggleGuard();
  const profileMutation = useFbGetProfile();
  const postsMutation = useFbGetPosts();
  const deletePostsMutation = useFbDeletePosts();
  const friendsMutation = useFbGetFriends();
  const unfriendMutation = useFbUnfriend();
  const updateProfileMutation = useFbUpdateProfile();
  const updateProfilePictureMutation = useFbUpdateProfilePicture();
  const createPostMutation = useFbCreatePost();
  const videosMutation = useFbGetVideos();
  const sharePostMutation = useFbSharePost();

  const emailForm = useForm<z.infer<typeof emailLoginSchema>>({
    resolver: zodResolver(emailLoginSchema),
    defaultValues: { email: "", password: "" },
  });

  const cookieForm = useForm<z.infer<typeof cookieLoginSchema>>({
    resolver: zodResolver(cookieLoginSchema),
    defaultValues: { cookie: "" },
  });

  const profileForm = useForm<z.infer<typeof profileEditSchema>>({
    resolver: zodResolver(profileEditSchema),
    defaultValues: { name: "", bio: "", city: "", work: "", education: "", relationship: "", website: "" },
  });

  const postForm = useForm<z.infer<typeof postSchema>>({
    resolver: zodResolver(postSchema),
    defaultValues: { message: "", privacy: "SELF" },
  });

  const pfpUrlForm = useForm<z.infer<typeof pfpUrlSchema>>({
    resolver: zodResolver(pfpUrlSchema),
    defaultValues: { imageUrl: "" },
  });

  const selectedVideo = useMemo(
    () => videos.find((video) => video.id === activeVideoId) ?? videos[0] ?? null,
    [activeVideoId, videos],
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    localStorage.setItem("fb-guard-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  useEffect(() => {
    if (auth) {
      localStorage.setItem("fb-guard-auth", JSON.stringify(auth));
    } else {
      localStorage.removeItem("fb-guard-auth");
    }
  }, [auth]);

  useEffect(() => {
    if (profile) {
      localStorage.setItem("fb-guard-profile", JSON.stringify(profile));
    } else {
      localStorage.removeItem("fb-guard-profile");
    }
  }, [profile]);

  const loadProfile = (token: string) => {
    profileMutation.mutate(
      { data: { token } },
      {
        onSuccess: (prof) => setProfile(prof),
        onError: () =>
          toast({ variant: "destructive", title: "Profile failed", description: "Could not load profile details." }),
      },
    );
  };

  const onLoginSuccess = (data: { token: string; userId: string; name: string; eaagToken?: string }) => {
    setAuth({ token: data.token, userId: data.userId, name: data.name, eaagToken: data.eaagToken });
    setGuardStatus(null);
    setProfile(null);
    setPosts([]);
    setFriends([]);
    setVideos([]);
    setSelectedPosts(new Set());
    toast({ title: "Logged in", description: `Welcome, ${data.name}` });
    window.setTimeout(() => loadProfile(data.token), 100);
  };

  const onEmailSubmit = (values: z.infer<typeof emailLoginSchema>) => {
    loginMutation.mutate(
      { data: values },
      {
        onSuccess: onLoginSuccess,
        onError: (err) =>
          toast({ variant: "destructive", title: "Login failed", description: err.message || "Failed to authenticate." }),
      },
    );
  };

  const onCookieSubmit = (values: z.infer<typeof cookieLoginSchema>) => {
    cookieLoginMutation.mutate(
      { data: values },
      {
        onSuccess: onLoginSuccess,
        onError: (err) =>
          toast({ variant: "destructive", title: "Login failed", description: err.message || "Failed to authenticate." }),
      },
    );
  };

  const handleToggleGuard = (enable: boolean) => {
    if (!auth) return;
    toggleGuardMutation.mutate(
      { data: { token: auth.token, enable } },
      {
        onSuccess: (data) => {
          setGuardStatus({ isShielded: data.isShielded, message: data.message });
          toast({
            title: data.success
              ? enable
                ? "Profile Guard Enabled"
                : "Profile Guard Disabled"
              : "Guard Toggle Failed",
            description: data.message,
            variant: data.success ? "default" : "destructive",
          });
        },
        onError: (err) =>
          toast({ variant: "destructive", title: "Error", description: err.message || "Failed to toggle guard." }),
      },
    );
  };

  const handleLoadPosts = () => {
    if (!auth) return;
    postsMutation.mutate(
      { data: { token: auth.token } },
      {
        onSuccess: (data) => {
          setPosts(data.posts);
          setSelectedPosts(new Set());
          toast({ title: "Posts loaded", description: `${data.posts.length} post(s) returned.` });
        },
        onError: (err) =>
          toast({ variant: "destructive", title: "Error", description: err.message || "Failed to load posts." }),
      },
    );
  };

  const handleLoadFriends = () => {
    if (!auth) return;
    friendsMutation.mutate(
      { data: { token: auth.token } },
      {
        onSuccess: (data) => {
          setFriends(data.friends);
          toast({ title: "Friends loaded", description: data.message });
        },
        onError: (err) =>
          toast({ variant: "destructive", title: "Error", description: err.message || "Failed to load friends." }),
      },
    );
  };

  const handleUnfriend = (friend: Friend) => {
    if (!auth) return;
    setUnfriendingIds((prev) => new Set(prev).add(friend.id));
    unfriendMutation.mutate(
      { data: { token: auth.token, friendId: friend.id } },
      {
        onSuccess: (result) => {
          setUnfriendingIds((prev) => {
            const next = new Set(prev);
            next.delete(friend.id);
            return next;
          });
          toast({
            title: result.success ? "Unfriended" : "Unfriend Failed",
            description: result.message,
            variant: result.success ? "default" : "destructive",
          });
          if (result.success) {
            setFriends((prev) => prev.filter((f) => f.id !== friend.id));
          }
        },
        onError: (err) => {
          setUnfriendingIds((prev) => {
            const next = new Set(prev);
            next.delete(friend.id);
            return next;
          });
          toast({ variant: "destructive", title: "Unfriend failed", description: err.message });
        },
      },
    );
  };

  const handleLoadVideos = () => {
    if (!auth) return;
    videosMutation.mutate(
      { data: { token: auth.token } },
      {
        onSuccess: (data) => {
          setVideos(data.videos);
          setActiveVideoId(data.videos[0]?.id ?? null);
          toast({ title: "Videos loaded", description: data.message });
        },
        onError: (err) =>
          toast({ variant: "destructive", title: "Error", description: err.message || "Failed to load videos." }),
      },
    );
  };

  const handleSelectAll = () => {
    setSelectedPosts(selectedPosts.size === posts.length ? new Set() : new Set(posts.map((p) => p.id)));
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
            title: "Delete complete",
            description: result.message,
            variant: result.failed > 0 ? "destructive" : "default",
          });
          if (result.deleted > 0) setPosts((prev) => prev.filter((p) => !selectedPosts.has(p.id)));
          setSelectedPosts(new Set());
        },
        onError: (err) => toast({ variant: "destructive", title: "Delete failed", description: err.message }),
      },
    );
  };

  const handleCreatePost = (values: z.infer<typeof postSchema>) => {
    if (!auth) return;
    createPostMutation.mutate(
      { data: { token: auth.token, message: values.message, privacy: values.privacy || "SELF" } },
      {
        onSuccess: (result) => {
          toast({
            title: result.success ? "Post submitted" : "Post failed",
            description: result.message,
            variant: result.success ? "default" : "destructive",
          });
          if (result.success && result.post) {
            setPosts((prev) => [result.post as Post, ...prev]);
            postForm.reset({ message: "", privacy: values.privacy || "SELF" });
          }
        },
        onError: (err) => toast({ variant: "destructive", title: "Post failed", description: err.message }),
      },
    );
  };

  const handleUpdateProfile = (values: z.infer<typeof profileEditSchema>) => {
    if (!auth) return;
    updateProfileMutation.mutate(
      { data: { token: auth.token, ...values } },
      {
        onSuccess: (result) => {
          toast({
            title: result.success ? "Profile update sent" : "Profile update blocked",
            description: result.message,
            variant: result.success ? "default" : "destructive",
          });
          if (result.success) loadProfile(auth.token);
        },
        onError: (err) => toast({ variant: "destructive", title: "Update failed", description: err.message }),
      },
    );
  };

  const handleProfilePictureChangeFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!auth) return;
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast({ variant: "destructive", title: "Invalid file", description: "Choose an image file." });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast({ variant: "destructive", title: "Image too large", description: "Choose an image under 10MB." });
      return;
    }
    try {
      const imageData = await fileToDataUrl(file);
      updateProfilePictureMutation.mutate(
        { data: { token: auth.token, imageData, fileName: file.name } },
        {
          onSuccess: (result) => {
            toast({
              title: result.success ? "Profile picture updated" : "Profile picture failed",
              description: result.message,
              variant: result.success ? "default" : "destructive",
            });
            if (result.profilePicUrl) {
              setImgError(false);
              setProfile((prev) => (prev ? { ...prev, profilePicUrl: result.profilePicUrl || prev.profilePicUrl } : prev));
            }
            if (result.success) loadProfile(auth.token);
          },
          onError: (err) => toast({ variant: "destructive", title: "Upload failed", description: err.message }),
        },
      );
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Could not read image.",
      });
    }
  };

  const handleProfilePictureChangeUrl = (values: z.infer<typeof pfpUrlSchema>) => {
    if (!auth) return;
    updateProfilePictureMutation.mutate(
      { data: { token: auth.token, imageUrl: values.imageUrl, fileName: "profile.jpg" } },
      {
        onSuccess: (result) => {
          toast({
            title: result.success ? "Profile picture updated" : "Profile picture failed",
            description: result.message,
            variant: result.success ? "default" : "destructive",
          });
          if (result.profilePicUrl) {
            setImgError(false);
            setProfile((prev) => (prev ? { ...prev, profilePicUrl: result.profilePicUrl || prev.profilePicUrl } : prev));
          }
          if (result.success) {
            pfpUrlForm.reset();
            loadProfile(auth.token);
          }
        },
        onError: (err) => toast({ variant: "destructive", title: "Upload failed", description: err.message }),
      },
    );
  };

  const handleShare = () => {
    if (!auth || !shareUrl.trim()) return;
    const url = shareUrl.trim();
    const cnt = Math.max(1, shareCount);
    setShareLogs(["Starting share process..."]);
    setShareResult(null);
    sharePostMutation.mutate(
      { data: { token: auth.token, postUrl: url, count: cnt } },
      {
        onSuccess: (result) => {
          setShareLogs(result.details);
          setShareResult({ success: result.success, failed: result.failed, message: result.message });
          toast({
            title: result.success > 0 ? "Shares completed" : "All shares failed",
            description: result.message,
            variant: result.success > 0 ? "default" : "destructive",
          });
        },
        onError: (err) => {
          setShareLogs(["Error: " + (err.message || "Unknown error")]);
          toast({ variant: "destructive", title: "Share failed", description: err.message || "Could not share post." });
        },
      }
    );
  };

  const handleLogout = () => {
    setAuth(null);
    localStorage.removeItem("fb-guard-auth");
    setGuardStatus(null);
    setProfile(null);
    setPosts([]);
    setFriends([]);
    setVideos([]);
    setActiveVideoId(null);
    setSelectedPosts(new Set());
    setImgError(false);
    setShareLogs([]);
    setShareResult(null);
    setShareUrl("");
    emailForm.reset();
    cookieForm.reset();
    profileForm.reset();
    postForm.reset();
    pfpUrlForm.reset();
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      toast({ title: "Copied", description: `${label} copied to clipboard.` });
    });
  };

  if (!auth) {
    return (
      <div className="min-h-screen bg-[#F0F2F5] p-4 text-slate-900 dark:bg-[#18191A] dark:text-slate-100">
        <div className="mx-auto flex min-h-[calc(100vh-2rem)] w-full max-w-md flex-col justify-center space-y-6">
          <div className="flex justify-end">
            <ThemeToggle darkMode={darkMode} onToggle={() => setDarkMode((value) => !value)} />
          </div>
          <div className="space-y-2 text-center">
            <div className="flex items-center justify-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#1877F2] shadow-lg shadow-blue-500/20">
                <Shield className="h-8 w-8 text-white" />
              </div>
            </div>
            <h1 className="text-3xl font-bold text-slate-950 dark:text-white">Facebook Guard</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Manage guard, friends, posts, profile & videos
            </p>
          </div>

          <Card className="overflow-hidden rounded-3xl border-0 shadow-xl dark:bg-[#242526]">
            <CardContent className="p-6">
              <Tabs defaultValue="cookie" className="w-full">
                <TabsList className="mb-6 grid w-full grid-cols-2 rounded-2xl bg-slate-100 p-1 dark:bg-slate-800">
                  <TabsTrigger
                    value="cookie"
                    className="rounded-xl data-[state=active]:bg-white data-[state=active]:text-[#1877F2] dark:data-[state=active]:bg-slate-700"
                  >
                    <Cookie className="mr-2 h-4 w-4" />
                    Cookie Login
                  </TabsTrigger>
                  <TabsTrigger
                    value="email"
                    className="rounded-xl data-[state=active]:bg-white data-[state=active]:text-[#1877F2] dark:data-[state=active]:bg-slate-700"
                  >
                    <KeyRound className="mr-2 h-4 w-4" />
                    Password Login
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="cookie">
                  <Form {...cookieForm}>
                    <form onSubmit={cookieForm.handleSubmit(onCookieSubmit)} className="space-y-4">
                      <FormField
                        control={cookieForm.control}
                        name="cookie"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Facebook Cookie</FormLabel>
                            <FormControl>
                              <textarea
                                placeholder="Paste your full Facebook cookie string here (c_user=...; xs=...;)"
                                className="min-h-[120px] w-full resize-none rounded-2xl border border-slate-200 bg-white p-3 text-sm outline-none focus:ring-2 focus:ring-[#1877F2] dark:border-slate-700 dark:bg-slate-900"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <Button
                        type="submit"
                        className="h-12 w-full rounded-2xl bg-[#1877F2] text-base font-semibold hover:bg-[#0f66d4]"
                        disabled={cookieLoginMutation.isPending}
                      >
                        {cookieLoginMutation.isPending ? (
                          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                        ) : (
                          <Cookie className="mr-2 h-5 w-5" />
                        )}
                        {cookieLoginMutation.isPending ? "Connecting..." : "Login with Cookie"}
                      </Button>
                    </form>
                  </Form>
                </TabsContent>

                <TabsContent value="email">
                  <Form {...emailForm}>
                    <form onSubmit={emailForm.handleSubmit(onEmailSubmit)} className="space-y-4">
                      <FormField
                        control={emailForm.control}
                        name="email"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Email or Phone</FormLabel>
                            <FormControl>
                              <Input placeholder="email@example.com or phone number" className="h-11 rounded-2xl" {...field} />
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
                            <FormLabel>Password</FormLabel>
                            <FormControl>
                              <Input type="password" placeholder="••••••••" className="h-11 rounded-2xl" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                        Facebook may block password logins from cloud servers. Cookie Login usually works better.
                      </div>
                      <Button
                        type="submit"
                        className="h-12 w-full rounded-2xl bg-[#1877F2] text-base font-semibold hover:bg-[#0f66d4]"
                        disabled={loginMutation.isPending}
                      >
                        {loginMutation.isPending ? (
                          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                        ) : (
                          <KeyRound className="mr-2 h-5 w-5" />
                        )}
                        {loginMutation.isPending ? "Logging in..." : "Login with Password"}
                      </Button>
                    </form>
                  </Form>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F0F2F5] p-4 text-slate-900 dark:bg-[#18191A] dark:text-slate-100">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="sticky top-0 z-20 -mx-4 border-b border-slate-200 bg-[#F0F2F5]/95 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-[#18191A]/95">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1877F2]">
                <Shield className="h-5 w-5 text-white" />
              </div>
              <div className="min-w-0">
                <p className="truncate font-bold">Facebook Guard</p>
                <p className="truncate text-xs text-slate-500 dark:text-slate-400">UID: {auth.userId}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ThemeToggle darkMode={darkMode} onToggle={() => setDarkMode((value) => !value)} />
              <Button
                variant="outline"
                size="sm"
                onClick={handleLogout}
                className="rounded-2xl border-slate-200 dark:border-slate-700"
              >
                <LogOut className="mr-1 h-4 w-4" /> Logout
              </Button>
            </div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
          <div className="space-y-4">
            <Card className="overflow-hidden rounded-3xl border-0 shadow-sm dark:bg-[#242526]">
              <CardContent className="p-6">
                <div className="flex items-start gap-4">
                  <div className="relative shrink-0">
                    {profile?.profilePicUrl && !imgError ? (
                      <img
                        src={profile.profilePicUrl}
                        alt="Profile"
                        className="h-24 w-24 rounded-full border-4 border-white object-cover shadow-md dark:border-slate-800"
                        onError={() => setImgError(true)}
                      />
                    ) : (
                      <div className="flex h-24 w-24 items-center justify-center rounded-full border-4 border-white bg-[#1877F2] shadow-md dark:border-slate-800">
                        <User className="h-12 w-12 text-white" />
                      </div>
                    )}
                    {guardStatus?.isShielded && (
                      <div className="absolute bottom-0 right-0 flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-green-500 dark:border-slate-800">
                        <ShieldCheck className="h-5 w-5 text-white" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-2xl font-bold">{auth.name}</h2>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Connected account</p>
                    {profileMutation.isPending && (
                      <p className="mt-2 flex items-center gap-1 text-xs text-[#1877F2]">
                        <Loader2 className="h-3 w-3 animate-spin" /> Loading profile...
                      </p>
                    )}
                    {guardStatus && (
                      <Badge
                        variant="outline"
                        className={`mt-3 ${guardStatus.isShielded ? "border-green-300 bg-green-50 text-green-700 dark:bg-green-950/30" : "border-slate-300 bg-slate-50 text-slate-600 dark:bg-slate-800"}`}
                      >
                        {guardStatus.isShielded ? "Guard Active" : "Guard Inactive"}
                      </Badge>
                    )}
                  </div>
                </div>

                {profile && (
                  <div className="mt-6 grid grid-cols-3 gap-3">
                    <StatCard
                      icon={<Users className="h-5 w-5" />}
                      label="Friends"
                      value={profile.friendsCount > 0 ? profile.friendsCount.toLocaleString() : friends.length || "—"}
                    />
                    <StatCard icon={<User className="h-5 w-5" />} label="Gender" value={profile.gender || "—"} />
                    <StatCard
                      icon={<FileText className="h-5 w-5" />}
                      label="Posts"
                      value={posts.length || profile.postCount || "—"}
                    />
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="rounded-3xl border-0 shadow-sm dark:bg-[#242526]">
              <CardContent className="p-6">
                <h3 className="mb-1 flex items-center gap-2 font-semibold">
                  <ShieldCheck className="h-5 w-5 text-[#1877F2]" /> Profile Guard
                </h3>
                <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
                  Enable or disable Facebook Profile Guard.
                </p>
                {guardStatus && (
                  <div
                    className={`mb-4 rounded-2xl border p-3 text-sm ${guardStatus.isShielded ? "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/30" : "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800"}`}
                  >
                    {guardStatus.message}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <Button
                    onClick={() => handleToggleGuard(true)}
                    disabled={toggleGuardMutation.isPending}
                    className="h-11 rounded-2xl bg-[#1877F2] font-semibold hover:bg-[#0f66d4]"
                  >
                    {toggleGuardMutation.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="mr-2 h-4 w-4" />
                    )}
                    Enable
                  </Button>
                  <Button
                    onClick={() => handleToggleGuard(false)}
                    disabled={toggleGuardMutation.isPending}
                    variant="outline"
                    className="h-11 rounded-2xl font-semibold"
                  >
                    <ShieldOff className="mr-2 h-4 w-4" /> Disable
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Access Token Card */}
            <Card className="rounded-3xl border-0 shadow-sm dark:bg-[#242526]">
              <CardHeader className="p-4 pb-0">
                <button
                  className="flex w-full items-center justify-between text-left"
                  onClick={() => setShowToken((v) => !v)}
                >
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    <KeyRound className="h-4 w-4 text-[#1877F2]" /> Access Token
                  </span>
                  {showToken ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
                </button>
              </CardHeader>
              {showToken && (
                <CardContent className="p-4 pt-3 space-y-3">
                  {auth.eaagToken ? (
                    <div>
                      <p className="mb-1 text-xs font-semibold text-[#1877F2]">EAAG Access Token (from business.facebook.com):</p>
                      <div className="flex items-start gap-2 rounded-xl bg-slate-100 p-3 dark:bg-slate-800">
                        <p className="flex-1 break-all font-mono text-xs text-slate-700 dark:text-slate-300">
                          {auth.eaagToken}
                        </p>
                        <button
                          onClick={() => copyToClipboard(auth.eaagToken!, "EAAG token")}
                          className="mt-0.5 shrink-0 text-[#1877F2] hover:text-[#0f66d4]"
                        >
                          <Copy className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-amber-600 dark:text-amber-400">EAAG token not found. Cookie may not have access to business.facebook.com.</p>
                  )}
                  <p className="text-xs text-slate-400">UID: {auth.userId}</p>
                </CardContent>
              )}
            </Card>

            {profile && Object.keys(profile.parsedCookies).length > 0 && (
              <Card className="rounded-3xl border-0 shadow-sm dark:bg-[#242526]">
                <CardHeader className="p-4 pb-0">
                  <button
                    className="flex w-full items-center justify-between text-left"
                    onClick={() => setShowCookies((value) => !value)}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold">
                      <Cookie className="h-4 w-4 text-[#1877F2]" /> Cookie Details
                    </span>
                    {showCookies ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
                  </button>
                </CardHeader>
                {showCookies && (
                  <CardContent className="max-h-56 overflow-y-auto p-4 pt-3 text-xs">
                    {Object.entries(profile.parsedCookies).map(([key, value]) => (
                      <div key={key} className="flex gap-2 border-b border-slate-100 py-1.5 last:border-0 dark:border-slate-800">
                        <span className="w-28 shrink-0 font-semibold text-[#1877F2]">{key}</span>
                        <span className="break-all text-slate-600 dark:text-slate-400">
                          {value.length > 70 ? `${value.slice(0, 70)}…` : value}
                        </span>
                      </div>
                    ))}
                  </CardContent>
                )}
              </Card>
            )}
          </div>

          <Tabs defaultValue="share" className="space-y-4">
            <TabsList className="grid h-auto grid-cols-6 rounded-3xl bg-white p-1 shadow-sm dark:bg-[#242526]">
              <TabsTrigger value="share" className="rounded-2xl">
                <Share2 className="mr-1 h-4 w-4" /> Share
              </TabsTrigger>
              <TabsTrigger value="feed" className="rounded-2xl">
                <FileText className="mr-1 h-4 w-4" /> Posts
              </TabsTrigger>
              <TabsTrigger value="friends" className="rounded-2xl">
                <Users className="mr-1 h-4 w-4" /> Friends
              </TabsTrigger>
              <TabsTrigger value="profile" className="rounded-2xl">
                <Edit3 className="mr-1 h-4 w-4" /> Profile
              </TabsTrigger>
              <TabsTrigger value="watch" className="rounded-2xl">
                <Video className="mr-1 h-4 w-4" /> Watch
              </TabsTrigger>
              <TabsTrigger value="all" className="rounded-2xl">
                <Shield className="mr-1 h-4 w-4" /> All
              </TabsTrigger>
            </TabsList>

            <TabsContent value="share" className="space-y-4">
              <Card className="rounded-3xl border-0 shadow-sm dark:bg-[#242526]">
                <CardContent className="p-6">
                  <h3 className="mb-1 flex items-center gap-2 font-semibold">
                    <Share2 className="h-5 w-5 text-[#1877F2]" /> Share Post
                  </h3>
                  <p className="mb-5 text-sm text-slate-500 dark:text-slate-400">
                    Share any Facebook post link multiple times using your account.
                  </p>

                  <div className="space-y-4">
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
                        Post URL
                      </label>
                      <Input
                        value={shareUrl}
                        onChange={(e) => setShareUrl(e.target.value)}
                        placeholder="https://www.facebook.com/.../posts/..."
                        className="h-11 rounded-2xl"
                        disabled={sharePostMutation.isPending}
                      />
                    </div>

                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
                        Number of Shares (1–100)
                      </label>
                      <Input
                        type="number"
                        min={1}
                        max={100}
                        value={shareCount}
                        onChange={(e) => setShareCount(Number(e.target.value))}
                        className="h-11 rounded-2xl"
                        disabled={sharePostMutation.isPending}
                      />
                    </div>

                    <Button
                      onClick={handleShare}
                      disabled={sharePostMutation.isPending || !shareUrl.trim()}
                      className="h-12 w-full rounded-2xl bg-[#1877F2] text-base font-semibold hover:bg-[#0f66d4]"
                    >
                      {sharePostMutation.isPending ? (
                        <>
                          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                          Sharing... (this takes time, please wait)
                        </>
                      ) : (
                        <>
                          <Share2 className="mr-2 h-5 w-5" />
                          Share {shareCount} Time{shareCount !== 1 ? "s" : ""}
                        </>
                      )}
                    </Button>

                    {shareResult && (
                      <div
                        className={`rounded-2xl border p-4 text-sm ${
                          shareResult.failed === 0
                            ? "border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/30 dark:text-green-300"
                            : shareResult.success === 0
                            ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"
                            : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
                        }`}
                      >
                        <div className="font-semibold">{shareResult.message}</div>
                        <div className="mt-1 text-xs">
                          {shareResult.success} succeeded · {shareResult.failed} failed
                        </div>
                      </div>
                    )}

                    {shareLogs.length > 0 && (
                      <div className="rounded-2xl border border-slate-200 bg-slate-950 p-4 dark:border-slate-700">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                          Share Log
                        </p>
                        <div className="max-h-64 space-y-1 overflow-y-auto font-mono text-xs">
                          {shareLogs.map((log, i) => (
                            <div
                              key={i}
                              className={
                                log.includes("Success")
                                  ? "text-green-400"
                                  : log.includes("Failed") || log.includes("Error") || log.includes("Stopping") || log.includes("failed")
                                  ? "text-red-400"
                                  : log.includes("Token") || log.includes("token")
                                  ? "text-yellow-400"
                                  : "text-slate-300"
                              }
                            >
                              {log}
                            </div>
                          ))}
                          {sharePostMutation.isPending && (
                            <div className="flex items-center gap-1 text-[#1877F2]">
                              <Loader2 className="h-3 w-3 animate-spin" /> Processing...
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="feed" className="space-y-4">
              <Card className="rounded-3xl border-0 shadow-sm dark:bg-[#242526]">
                <CardContent className="p-6">
                  <Form {...postForm}>
                    <form onSubmit={postForm.handleSubmit(handleCreatePost)} className="space-y-3">
                      <FormField
                        control={postForm.control}
                        name="message"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="flex items-center gap-2">
                              <MessageCircle className="h-4 w-4 text-[#1877F2]" /> Create New Post
                            </FormLabel>
                            <FormControl>
                              <textarea
                                placeholder={`What's on your mind, ${auth.name}?`}
                                className="min-h-[110px] w-full resize-none rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm outline-none focus:ring-2 focus:ring-[#1877F2] dark:border-slate-700 dark:bg-slate-900"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <div className="flex flex-col gap-3 sm:flex-row">
                        <FormField
                          control={postForm.control}
                          name="privacy"
                          render={({ field }) => (
                            <FormItem className="sm:w-40">
                              <FormControl>
                                <select
                                  className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-900"
                                  {...field}
                                >
                                  <option value="SELF">Only me</option>
                                  <option value="ALL_FRIENDS">Friends</option>
                                  <option value="EVERYONE">Public</option>
                                </select>
                              </FormControl>
                            </FormItem>
                          )}
                        />
                        <Button
                          type="submit"
                          disabled={createPostMutation.isPending}
                          className="h-11 flex-1 rounded-2xl bg-[#1877F2] font-semibold hover:bg-[#0f66d4]"
                        >
                          {createPostMutation.isPending ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Send className="mr-2 h-4 w-4" />
                          )}
                          Post Now
                        </Button>
                      </div>
                    </form>
                  </Form>
                </CardContent>
              </Card>

              <Card className="rounded-3xl border-0 shadow-sm dark:bg-[#242526]">
                <CardContent className="p-6">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="flex items-center gap-2 font-semibold">
                        <FileText className="h-5 w-5 text-[#1877F2]" /> Post Management
                      </h3>
                      <p className="text-sm text-slate-500 dark:text-slate-400">Display, select, and delete posts.</p>
                    </div>
                    <Button
                      onClick={handleLoadPosts}
                      disabled={postsMutation.isPending}
                      variant="outline"
                      className="rounded-2xl border-[#1877F2] text-[#1877F2] hover:bg-blue-50 dark:hover:bg-blue-950/30"
                    >
                      {postsMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                      Load Posts
                    </Button>
                  </div>

                  {posts.length > 0 && (
                    <div className="mb-3 flex items-center justify-between">
                      <button
                        onClick={handleSelectAll}
                        className="flex items-center gap-2 text-sm font-medium text-[#1877F2] hover:underline"
                      >
                        {selectedPosts.size === posts.length ? (
                          <CheckSquare className="h-4 w-4" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                        {selectedPosts.size === posts.length ? "Deselect All" : "Select All"}
                      </button>
                      {selectedPosts.size > 0 && (
                        <Button
                          onClick={handleDeleteSelected}
                          disabled={deletePostsMutation.isPending}
                          size="sm"
                          className="h-9 rounded-2xl bg-red-500 text-xs font-semibold text-white hover:bg-red-600"
                        >
                          {deletePostsMutation.isPending ? (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          ) : (
                            <Trash2 className="mr-1 h-3 w-3" />
                          )}
                          Delete {selectedPosts.size}
                        </Button>
                      )}
                    </div>
                  )}

                  <div className="space-y-3">
                    {posts.length === 0 && !postsMutation.isPending ? (
                      <EmptyState text="Load posts to display your Facebook timeline posts here." />
                    ) : (
                      posts.map((post) => (
                        <div
                          key={post.id}
                          className={`rounded-2xl border p-4 transition-colors ${selectedPosts.has(post.id) ? "border-[#1877F2] bg-blue-50 dark:bg-blue-950/30" : "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/60"}`}
                        >
                          <div className="flex items-start gap-3">
                            <button onClick={() => handleTogglePost(post.id)} className="mt-1 shrink-0">
                              {selectedPosts.has(post.id) ? (
                                <CheckSquare className="h-5 w-5 text-[#1877F2]" />
                              ) : (
                                <Square className="h-5 w-5 text-slate-400" />
                              )}
                            </button>
                            <div className="min-w-0 flex-1">
                              <p className="whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-100">
                                {post.message}
                              </p>
                              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                                <span>{new Date(post.createdTime).toLocaleString()}</span>
                                <span>ID: {post.id.slice(0, 18)}</span>
                                {post.permalink && (
                                  <a
                                    className="inline-flex items-center gap-1 text-[#1877F2] hover:underline"
                                    href={post.permalink}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Open <ExternalLink className="h-3 w-3" />
                                  </a>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="friends" className="space-y-4">
              <Card className="rounded-3xl border-0 shadow-sm dark:bg-[#242526]">
                <CardContent className="p-6">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="flex items-center gap-2 font-semibold">
                        <Users className="h-5 w-5 text-[#1877F2]" /> Friends
                        {friends.length > 0 && (
                          <span className="rounded-full bg-[#1877F2]/10 px-2 py-0.5 text-xs font-bold text-[#1877F2]">
                            {friends.length}
                          </span>
                        )}
                      </h3>
                      <p className="text-sm text-slate-500 dark:text-slate-400">
                        Your real Facebook friends with profile pictures.
                      </p>
                    </div>
                    <Button
                      onClick={handleLoadFriends}
                      disabled={friendsMutation.isPending}
                      className="rounded-2xl bg-[#1877F2] hover:bg-[#0f66d4]"
                    >
                      {friendsMutation.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-2 h-4 w-4" />
                      )}
                      {friends.length > 0 ? "Refresh Friends" : "Load Friends"}
                    </Button>
                  </div>

                  {friends.length === 0 && !friendsMutation.isPending ? (
                    <EmptyState text="Click 'Load Friends' to fetch your Facebook friends." />
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {friends.map((friend) => (
                        <div
                          key={friend.id}
                          className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900/60"
                        >
                          <a
                            href={friend.profileUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="shrink-0"
                          >
                            <img
                              src={friend.pictureUrl}
                              alt={friend.name}
                              className="h-12 w-12 rounded-full object-cover ring-2 ring-slate-200 dark:ring-slate-700"
                              onError={(e) => {
                                (e.target as HTMLImageElement).src = `https://graph.facebook.com/${friend.id}/picture?type=large`;
                              }}
                            />
                          </a>
                          <div className="min-w-0 flex-1">
                            <a
                              href={friend.profileUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="block truncate text-sm font-semibold hover:text-[#1877F2]"
                            >
                              {friend.name}
                            </a>
                            <p className="truncate text-xs text-slate-500">{friend.id}</p>
                          </div>
                          <button
                            onClick={() => handleUnfriend(friend)}
                            disabled={unfriendingIds.has(friend.id)}
                            className="shrink-0 rounded-xl border border-red-200 bg-red-50 p-1.5 text-red-500 transition-colors hover:bg-red-100 disabled:opacity-50 dark:border-red-900 dark:bg-red-950/30 dark:hover:bg-red-900/40"
                            title="Unfriend"
                          >
                            {unfriendingIds.has(friend.id) ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <UserMinus className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="profile" className="space-y-4">
              <Card className="rounded-3xl border-0 shadow-sm dark:bg-[#242526]">
                <CardContent className="p-6">
                  <h3 className="mb-1 flex items-center gap-2 font-semibold">
                    <Image className="h-5 w-5 text-[#1877F2]" /> Change Profile Picture
                  </h3>
                  <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
                    Upload a file or paste an image URL.
                  </p>

                  <div className="mb-4 flex gap-2">
                    <button
                      onClick={() => setPfpMode("file")}
                      className={`flex-1 rounded-xl border py-2 text-sm font-medium transition-colors ${pfpMode === "file" ? "border-[#1877F2] bg-blue-50 text-[#1877F2] dark:bg-blue-950/30" : "border-slate-200 dark:border-slate-700"}`}
                    >
                      Upload File
                    </button>
                    <button
                      onClick={() => setPfpMode("url")}
                      className={`flex-1 rounded-xl border py-2 text-sm font-medium transition-colors ${pfpMode === "url" ? "border-[#1877F2] bg-blue-50 text-[#1877F2] dark:bg-blue-950/30" : "border-slate-200 dark:border-slate-700"}`}
                    >
                      From URL
                    </button>
                  </div>

                  {pfpMode === "file" ? (
                    <div>
                      <label className="flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 p-6 transition-colors hover:border-[#1877F2] hover:bg-blue-50 dark:border-slate-700 dark:hover:bg-blue-950/20">
                        {updateProfilePictureMutation.isPending ? (
                          <Loader2 className="h-8 w-8 animate-spin text-[#1877F2]" />
                        ) : (
                          <Image className="h-8 w-8 text-slate-400" />
                        )}
                        <span className="text-sm font-medium text-slate-600 dark:text-slate-400">
                          {updateProfilePictureMutation.isPending ? "Uploading..." : "Click to choose an image"}
                        </span>
                        <span className="text-xs text-slate-400">JPG, PNG, GIF up to 10MB</span>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={handleProfilePictureChangeFile}
                          disabled={updateProfilePictureMutation.isPending}
                        />
                      </label>
                    </div>
                  ) : (
                    <Form {...pfpUrlForm}>
                      <form onSubmit={pfpUrlForm.handleSubmit(handleProfilePictureChangeUrl)} className="space-y-3">
                        <FormField
                          control={pfpUrlForm.control}
                          name="imageUrl"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Image URL</FormLabel>
                              <FormControl>
                                <Input
                                  placeholder="https://example.com/image.jpg"
                                  className="h-11 rounded-2xl"
                                  {...field}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <Button
                          type="submit"
                          disabled={updateProfilePictureMutation.isPending}
                          className="h-11 w-full rounded-2xl bg-[#1877F2] font-semibold hover:bg-[#0f66d4]"
                        >
                          {updateProfilePictureMutation.isPending ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Image className="mr-2 h-4 w-4" />
                          )}
                          {updateProfilePictureMutation.isPending ? "Uploading..." : "Set Profile Picture from URL"}
                        </Button>
                      </form>
                    </Form>
                  )}
                </CardContent>
              </Card>

              <Card className="rounded-3xl border-0 shadow-sm dark:bg-[#242526]">
                <CardContent className="p-6">
                  <h3 className="mb-1 flex items-center gap-2 font-semibold">
                    <Edit3 className="h-5 w-5 text-[#1877F2]" /> Update Profile Info
                  </h3>
                  <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
                    Submit profile changes. Bio update is fully supported.
                  </p>
                  <Form {...profileForm}>
                    <form onSubmit={profileForm.handleSubmit(handleUpdateProfile)} className="grid gap-3 sm:grid-cols-2">
                      <FormField
                        control={profileForm.control}
                        name="name"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="flex items-center gap-1">
                              <User className="h-3 w-3" /> Name
                            </FormLabel>
                            <FormControl>
                              <Input className="rounded-2xl" placeholder={auth.name} {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={profileForm.control}
                        name="city"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="flex items-center gap-1">
                              <MapPin className="h-3 w-3" /> City
                            </FormLabel>
                            <FormControl>
                              <Input className="rounded-2xl" placeholder="Current city" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={profileForm.control}
                        name="work"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="flex items-center gap-1">
                              <Briefcase className="h-3 w-3" /> Work
                            </FormLabel>
                            <FormControl>
                              <Input className="rounded-2xl" placeholder="Workplace" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={profileForm.control}
                        name="education"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="flex items-center gap-1">
                              <GraduationCap className="h-3 w-3" /> Education
                            </FormLabel>
                            <FormControl>
                              <Input className="rounded-2xl" placeholder="School" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={profileForm.control}
                        name="relationship"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="flex items-center gap-1">
                              <Heart className="h-3 w-3" /> Relationship
                            </FormLabel>
                            <FormControl>
                              <Input className="rounded-2xl" placeholder="Relationship status" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={profileForm.control}
                        name="website"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="flex items-center gap-1">
                              <Link2 className="h-3 w-3" /> Website
                            </FormLabel>
                            <FormControl>
                              <Input className="rounded-2xl" placeholder="https://..." {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={profileForm.control}
                        name="bio"
                        render={({ field }) => (
                          <FormItem className="sm:col-span-2">
                            <FormLabel>Bio</FormLabel>
                            <FormControl>
                              <textarea
                                className="min-h-[90px] w-full resize-none rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm outline-none focus:ring-2 focus:ring-[#1877F2] dark:border-slate-700 dark:bg-slate-900"
                                placeholder="Write your bio"
                                {...field}
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <Button
                        type="submit"
                        disabled={updateProfileMutation.isPending}
                        className="h-11 rounded-2xl bg-[#1877F2] hover:bg-[#0f66d4] sm:col-span-2"
                      >
                        {updateProfileMutation.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Edit3 className="mr-2 h-4 w-4" />
                        )}
                        Update Profile
                      </Button>
                    </form>
                  </Form>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="watch" className="space-y-4">
              <Card className="rounded-3xl border-0 shadow-sm dark:bg-[#242526]">
                <CardContent className="p-6">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="flex items-center gap-2 font-semibold">
                        <Video className="h-5 w-5 text-[#1877F2]" /> Watch Videos
                      </h3>
                      <p className="text-sm text-slate-500 dark:text-slate-400">
                        Load videos and play them inside the app.
                      </p>
                    </div>
                    <Button
                      onClick={handleLoadVideos}
                      disabled={videosMutation.isPending}
                      className="rounded-2xl bg-[#1877F2] hover:bg-[#0f66d4]"
                    >
                      {videosMutation.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Play className="mr-2 h-4 w-4" />
                      )}
                      Load Videos
                    </Button>
                  </div>
                  {selectedVideo ? (
                    <div className="space-y-4">
                      <div className="overflow-hidden rounded-3xl bg-black">
                        {selectedVideo.videoUrl ? (
                          <video
                            src={selectedVideo.videoUrl}
                            poster={selectedVideo.thumbnailUrl || undefined}
                            controls
                            className="aspect-video w-full"
                          />
                        ) : (
                          <div className="flex aspect-video items-center justify-center text-white">
                            Video URL unavailable
                          </div>
                        )}
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {videos.map((video) => (
                          <button
                            key={video.id}
                            onClick={() => setActiveVideoId(video.id)}
                            className={`flex gap-3 rounded-2xl border p-3 text-left ${selectedVideo.id === video.id ? "border-[#1877F2] bg-blue-50 dark:bg-blue-950/30" : "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/60"}`}
                          >
                            <div className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-black">
                              {video.thumbnailUrl ? (
                                <img src={video.thumbnailUrl} alt={video.title} className="h-full w-full object-cover" />
                              ) : (
                                <Play className="h-6 w-6 text-white" />
                              )}
                            </div>
                            <div className="min-w-0">
                              <p className="line-clamp-2 text-sm font-semibold">{video.title}</p>
                              <p className="mt-1 text-xs text-slate-500">{new Date(video.createdTime).toLocaleDateString()}</p>
                              <a
                                href={video.permalink}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(event) => event.stopPropagation()}
                                className="mt-1 inline-flex items-center gap-1 text-xs text-[#1877F2] hover:underline"
                              >
                                Open on Facebook <ExternalLink className="h-3 w-3" />
                              </a>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <EmptyState text="Load videos to start watching." />
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="all" className="space-y-4">
              <Card className="rounded-3xl border-0 shadow-sm dark:bg-[#242526]">
                <CardContent className="p-6">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Button
                      onClick={handleLoadFriends}
                      className="h-12 rounded-2xl bg-[#1877F2] hover:bg-[#0f66d4]"
                    >
                      <Users className="mr-2 h-4 w-4" /> Fetch Friends
                    </Button>
                    <Button
                      onClick={handleLoadPosts}
                      className="h-12 rounded-2xl bg-[#1877F2] hover:bg-[#0f66d4]"
                    >
                      <FileText className="mr-2 h-4 w-4" /> Display Posts
                    </Button>
                    <Button
                      onClick={handleLoadVideos}
                      className="h-12 rounded-2xl bg-[#1877F2] hover:bg-[#0f66d4]"
                    >
                      <Video className="mr-2 h-4 w-4" /> Watch Videos
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        <p className="pb-4 text-center text-xs text-slate-400">Facebook Guard — v4.0</p>
      </div>
    </div>
  );
}
