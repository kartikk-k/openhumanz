/** Ambient top-left card listing the user's upcoming calendar items. */
export function UpcomingNext() {
  return (
    <div className="pointer-events-none fixed left-2 top-4 z-40 text-xs">
      <p className="px-2 opacity-30">Upcoming next:</p>
      <div className="pointer-events-auto mt-2 space-y-2">
        <div className="rounded-xl bg-white/10 p-2 duration-300 hover:bg-white/15">
          <p className="text-[11px] opacity-60">9:30 AM (in 5 mins)</p>
          <p className="opacity-80">Standup with core team</p>
        </div>

        <div className="rounded-xl bg-white/10 p-2 duration-300 hover:bg-white/15">
          <p className="text-[11px] opacity-60">12:00 PM (in 2 hours)</p>
          <p className="opacity-80">Review Aisha&apos;s design doc</p>
        </div>
      </div>
    </div>
  );
}

export default UpcomingNext;
