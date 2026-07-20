"use client";

import { Camera, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ProfileAvatar } from "@/components/ProfileAvatar";
import {
  BIO_MAX,
  USERNAME_MAX,
  bioError,
  cooldownRemainingMs,
  formatCooldown,
  normalizeUsername,
  usernameError,
} from "@/lib/profile/name";
import { useUpdateProfile, type Profile } from "@/lib/profile/useProfile";

/**
 * Claim or edit a wallet's public identity: picture, username, bio.
 *
 * Saving is a gasless signature, not a transaction. The 24h username cooldown is
 * enforced server-side; this only surfaces it, and only blocks an actual NAME
 * change (editing just the bio or picture is always allowed).
 */
export function EditProfileModal({
  profile,
  onClose,
}: {
  profile: Profile;
  onClose: () => void;
}) {
  const [username, setUsername] = useState(profile.username);
  const [bio, setBio] = useState(profile.bio);
  const [avatarUrl, setAvatarUrl] = useState(profile.avatarUrl ?? "");
  const [uploading, setUploading] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const update = useUpdateProfile();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const nameChanged = normalizeUsername(username) !== normalizeUsername(profile.username);
  // Only a wallet that already CLAIMED a name is on the clock; the first claim is free.
  const cooldown = profile.isCustom ? cooldownRemainingMs(profile.usernameSetAt) : 0;
  const nameLocked = nameChanged && cooldown > 0;
  const validationErr = usernameError(username) ?? bioError(bio);
  const canSave = !validationErr && !nameLocked && !uploading && !update.isPending;

  async function pickAvatar(file: File) {
    setUploading(true);
    setLocalErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = (await res.json()) as { uri?: string; error?: string };
      if (!res.ok || !data.uri) throw new Error(data.error || "upload failed");
      setAvatarUrl(data.uri);
    } catch (e) {
      setLocalErr(e instanceof Error ? e.message : "upload failed");
    } finally {
      setUploading(false);
    }
  }

  const shownErr = validationErr ?? localErr ?? (update.error as Error | null)?.message ?? null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-950 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="relative">
              <ProfileAvatar address={profile.address} avatarUrl={avatarUrl || null} size="lg" />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="absolute -bottom-1 -right-1 rounded-full border border-neutral-700 bg-neutral-900 p-1.5 text-neutral-300 transition-colors hover:text-amber-400 disabled:opacity-50"
                aria-label="Change profile picture"
                title="Change picture"
              >
                <Camera className="h-3.5 w-3.5" />
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void pickAvatar(f);
                }}
              />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-neutral-100">Edit your profile</h2>
              <p className="text-xs text-neutral-500">
                {uploading ? "Uploading picture…" : "Signing is free and gasless."}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-full border border-neutral-800 p-1.5 text-neutral-400 transition-colors hover:text-white"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="mt-5 block">
          <span className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-neutral-400">
            Username
            <span className="font-mono text-[11px] text-neutral-600">
              {normalizeUsername(username).length}/{USERNAME_MAX}
            </span>
          </span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={USERNAME_MAX}
            spellCheck={false}
            autoComplete="off"
            className="mt-1.5 w-full rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-2.5 text-sm text-neutral-100 outline-none focus:border-amber-500/60"
          />
          <span className="mt-1.5 block text-[11px] text-neutral-500">
            {nameLocked
              ? `You can change your username again in ${formatCooldown(cooldown)}.`
              : "You can change your username once every 24 hours."}
          </span>
        </label>

        <label className="mt-4 block">
          <span className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-neutral-400">
            Bio
            <span className="font-mono text-[11px] text-neutral-600">
              {bio.length}/{BIO_MAX}
            </span>
          </span>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={BIO_MAX}
            rows={3}
            placeholder="Describe your profile"
            className="mt-1.5 w-full resize-none rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-600 outline-none focus:border-amber-500/60"
          />
        </label>

        {shownErr && <p className="mt-3 text-xs text-red-400">{shownErr}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-neutral-800 px-4 py-2 text-sm text-neutral-400 transition-colors hover:text-neutral-200"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => update.mutate({ username, bio, avatarUrl }, { onSuccess: onClose })}
            className="btn-primary px-5 py-2 text-sm disabled:opacity-50"
          >
            {update.isPending ? "Sign to save…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
