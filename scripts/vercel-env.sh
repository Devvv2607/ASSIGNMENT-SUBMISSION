#!/usr/bin/env bash
# Push server env vars from .env.local to the Vercel project (values go via stdin, never argv).
# Requires: npx vercel login
set -euo pipefail
SCOPE=devmittal2607-3043s-projects
npx vercel link --yes --project proxy-dating --scope "$SCOPE" >/dev/null

val() { grep -E "^$1=" .env.local | head -1 | cut -d= -f2-; }

for key in APIFY_TOKEN GROQ_API_KEY SUPABASE_SERVICE_ROLE_KEY; do
  for env in production preview; do
    npx vercel env rm "$key" "$env" --yes --scope "$SCOPE" >/dev/null 2>&1 || true
    printf '%s' "$(val "$key")" | npx vercel env add "$key" "$env" --sensitive --scope "$SCOPE" >/dev/null
  done
  echo "set $key"
done

for kv in "NEXT_PUBLIC_SUPABASE_URL=$(val NEXT_PUBLIC_SUPABASE_URL)" MODEL_SMART=openai/gpt-oss-120b MODEL_FAST=openai/gpt-oss-20b MODEL_VISION=qwen/qwen3.8-27b ADD_LIMIT_PER_IP_PER_HOUR=5 ADD_LIMIT_PER_DAY=40; do
  key="${kv%%=*}"
  for env in production preview; do
    npx vercel env rm "$key" "$env" --yes --scope "$SCOPE" >/dev/null 2>&1 || true
    printf '%s' "${kv#*=}" | npx vercel env add "$key" "$env" --scope "$SCOPE" >/dev/null
  done
  echo "set $key"
done
