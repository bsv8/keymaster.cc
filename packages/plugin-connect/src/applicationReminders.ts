import { useSyncExternalStore } from "react";
import { APPLICATION_CONNECTIONS_CAPABILITY } from "@keymaster/contracts";
import { usePluginCapability } from "webloom-framework/react";

type ReminderState = { sound: "off" | "ready" | "failed"; notification: string };
function createReminders() {
  let state: ReminderState = { sound: "off", notification: "未开启" };
  let audio: AudioContext | undefined;
  let soundAt = 0;
  const listeners = new Set<() => void>();
  function update(value: Partial<ReminderState>) {
    state = { ...state, ...value };
    listeners.forEach(listener => listener());
  }
  async function play(manual: boolean) {
    if (!audio || audio.state !== "running") { if (state.sound !== "off") update({ sound: "failed" }); return; }
    if (Date.now() - soundAt < 1200) return;
    soundAt = Date.now();
    try {
      const oscillator = audio.createOscillator(), gain = audio.createGain();
      oscillator.connect(gain); gain.connect(audio.destination);
      oscillator.frequency.setValueAtTime(manual ? 740 : 440, audio.currentTime);
      if (manual) oscillator.frequency.setValueAtTime(550, audio.currentTime + .13);
      gain.gain.setValueAtTime(.075, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .35);
      oscillator.start(); oscillator.stop(audio.currentTime + .35);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    } catch { update({ sound: "failed" }); }
  }
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    play,
    async enableSound() {
      try {
        audio ??= new AudioContext();
        await audio.resume();
        if (audio.state !== "running") throw new Error("Audio unavailable");
        update({ sound: "ready" });
        await play(true);
      } catch { update({ sound: "failed" }); }
    },
    async enableNotifications() {
      try {
        if (typeof Notification === "undefined") { update({ notification: "浏览器不支持" }); return; }
        const permission = await Notification.requestPermission();
        update({ notification: permission === "granted" ? "已允许" : "未获允许" });
      } catch { update({ notification: "开启失败" }); }
    },
    notificationFailed() { update({ notification: "系统通知发送失败" }); },
    dispose() {
      void audio?.close();
      audio = undefined;
      soundAt = 0;
      update({ sound: "off", notification: "未开启" });
    },
  };
}
// 以应用连接能力实例隔离，设置页卸载不终止顶栏运行中的提醒。
const reminders = new WeakMap<object, ReturnType<typeof createReminders>>();
export function useApplicationReminders() {
  const reader = usePluginCapability(APPLICATION_CONNECTIONS_CAPABILITY);
  let controller = reminders.get(reader);
  if (!controller) { controller = createReminders(); reminders.set(reader, controller); }
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  return { controller, ...state };
}
