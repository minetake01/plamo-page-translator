import { cacheGet, cacheSet, clearCache, translationKey } from '../lib/cache';
import { geminiClassifyRegions, geminiDetectLanguage } from '../lib/gemini';
import { fail, ok, type Message, type Response } from '../lib/messages';
import { detectLanguage, probe, translateText } from '../lib/plamo';
import { bestProfile, hashString } from '../lib/profile';
import { loadSettings, saveSettings } from '../lib/settings';
import type { RegionRule, SiteProfile } from '../lib/types';

const PROFILE_KEY = 'plamo-profiles';

async function loadProfiles(): Promise<SiteProfile[]> {
  const stored = await browser.storage.local.get(PROFILE_KEY);
  const value = stored[PROFILE_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter((profile): profile is SiteProfile =>
    typeof profile === 'object' && profile !== null &&
    typeof (profile as SiteProfile).id === 'string' &&
    typeof (profile as SiteProfile).origin === 'string' &&
    Array.isArray((profile as SiteProfile).regions),
  );
}

async function saveProfiles(profiles: SiteProfile[]): Promise<void> {
  await browser.storage.local.set({ [PROFILE_KEY]: profiles.slice(0, 200) });
}

async function handle(message: Message, sender: { tab?: { windowId?: number } }): Promise<Response> {
  try {
    switch (message.type) {
      case 'settings:get':
        return ok(await loadSettings());
      case 'settings:set':
        return ok(await saveSettings(message.settings));
      case 'translate': {
        const settings = await loadSettings();
        const key = translationKey(settings, message.request);
        const cached = await cacheGet(key);
        if (cached !== undefined) return ok({ text: cached, cached: true });
        const text = await translateText(settings, message.request);
        await cacheSet(key, text);
        return ok({ text, cached: false });
      }
      case 'lang:detect':
        return ok(await detectLanguage(message.text));
      case 'gemini:detect': {
        const settings = await loadSettings();
        return ok(await geminiDetectLanguage(settings, message.text));
      }
      case 'gemini:classify': {
        const settings = await loadSettings();
        const result = await geminiClassifyRegions(
          settings,
          settings.geminiScreenshot ? message.image : undefined,
          message.page,
          message.regions,
        );
        return ok(Object.fromEntries(result));
      }
      case 'gemini:test': {
        const settings = await loadSettings();
        return ok(await geminiDetectLanguage(settings, 'This is a short English sentence.'));
      }
      case 'probe': {
        const settings = await loadSettings();
        return ok(await probe(settings));
      }
      case 'capture:visible': {
        if (!sender.tab?.windowId) throw new Error('no tab window');
        const image = await browser.tabs.captureVisibleTab(sender.tab.windowId, {
          format: 'jpeg',
          quality: 80,
        });
        return ok({ image });
      }
      case 'profile:match': {
        const profile = bestProfile(await loadProfiles(), message.query);
        return ok(profile ?? null);
      }
      case 'profile:save': {
        const profiles = await loadProfiles();
        const now = Date.now();
        const id = hashString(`${message.profile.origin}|${message.profile.skeletonHash}|${message.profile.viewportClass}`);
        const existing = profiles.find((profile) => profile.id === id);
        const profile: SiteProfile = {
          ...message.profile,
          id,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          hits: existing?.hits ?? 0,
        };
        const next = profiles.filter((candidate) => candidate.id !== id);
        next.unshift(profile);
        await saveProfiles(next);
        return ok(profile);
      }
      case 'profile:saveRule': {
        const profiles = await loadProfiles();
        const profile = profiles.find((candidate) => candidate.id === message.profileId);
        if (!profile) throw new Error('profile not found');
        const rule: RegionRule = message.rule;
        const existing = profile.regions.findIndex(
          (candidate) => candidate.selector === rule.selector && candidate.scope === rule.scope,
        );
        if (existing >= 0) profile.regions[existing] = rule;
        else profile.regions.unshift(rule);
        profile.updatedAt = Date.now();
        await saveProfiles(profiles);
        return ok(profile);
      }
      case 'profile:clear':
        await browser.storage.local.remove(PROFILE_KEY);
        return ok(true);
      case 'cache:clear':
        await clearCache();
        return ok(true);
      default:
        return fail(new Error('unknown message'));
    }
  } catch (error) {
    return fail(error);
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, sender) => handle(message as Message, sender as { tab?: { windowId?: number } }));

  browser.commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-translation') return;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) {
      await browser.tabs.sendMessage(tab.id, { type: 'ui:toggle' }).catch(() => undefined);
    }
  });
});
