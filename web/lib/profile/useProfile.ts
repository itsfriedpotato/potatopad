"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useSignMessage } from "wagmi";
import { profileHash } from "@/lib/feedback/message";
import { signAction } from "@/lib/feedback/sign";
import { normalizeUsername } from "./name";

export interface Profile {
  address: string;
  username: string;
  /** False while the wallet is still on its auto-generated name. */
  isCustom: boolean;
  bio: string;
  avatarUrl: string | null;
  usernameSetAt: string | null;
}

/** One wallet's profile. Falls back to the derived name server-side, so this is
 *  never empty for a valid address. */
export function useProfile(address?: string) {
  const key = address?.toLowerCase();
  return useQuery({
    queryKey: ["profile", key],
    enabled: !!key,
    staleTime: 60_000,
    queryFn: async (): Promise<Profile> => {
      const res = await fetch(`/api/profile?address=${key}`);
      if (!res.ok) throw new Error("Could not load profile");
      const { profiles } = (await res.json()) as { profiles: Record<string, Profile> };
      return profiles[key!];
    },
  });
}

/** Many wallets in ONE request — for lists, so names never fan out per card. */
export function useProfiles(addresses: string[]) {
  const keys = [...new Set(addresses.map((a) => a?.toLowerCase()).filter(Boolean))].sort();
  return useQuery({
    queryKey: ["profiles", keys.join(",")],
    enabled: keys.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Record<string, Profile>> => {
      const res = await fetch(`/api/profile?addresses=${keys.join(",")}`);
      if (!res.ok) throw new Error("Could not load profiles");
      const { profiles } = (await res.json()) as { profiles: Record<string, Profile> };
      return profiles;
    },
  });
}

/**
 * Gasless profile update: sign a message whose subject hashes every field being
 * saved, then POST it. Values are normalized BEFORE signing so the signed bytes
 * are exactly what the server persists.
 */
export function useUpdateProfile() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      username: string;
      bio: string;
      avatarUrl: string;
    }): Promise<Profile> => {
      if (!address) throw new Error("Connect your wallet first");
      const username = normalizeUsername(input.username);
      const bio = (input.bio || "").trim();
      const avatarUrl = (input.avatarUrl || "").trim();

      const subject = profileHash({ address, username, bio, avatarUrl });
      const { nonce, issuedAt, signature } = await signAction(
        address,
        "profile",
        subject,
        (message) => signMessageAsync({ message }),
      );

      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, username, bio, avatarUrl, nonce, issuedAt, signature }),
      });
      const json = (await res.json()) as { profile?: Profile; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not save profile");
      return json.profile!;
    },
    onSuccess: (profile) => {
      qc.setQueryData(["profile", profile.address], profile);
      qc.invalidateQueries({ queryKey: ["profiles"] });
    },
  });
}
