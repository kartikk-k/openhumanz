/** Ambient bottom-right card summarizing recent customer history. */
import icon from '../../image.png';

export function CustomerHistory() {
  return (
    <div className="fixed bottom-2 right-2 z-40 flex flex-row gap-4">
      <div className="flex max-w-xs flex-col items-center gap-1 rounded-3xl bg-black/20 p-4">
        <img src={icon} className="size-8" alt="message icon" />
        <p className="mt-2 text-xs">Customer history</p>
        <p className="text-center text-xs opacity-60">
          Called about a declined card while travelling. Resolved and travel
          notice added
        </p>
      </div>
    </div>
  );
}

export default CustomerHistory;
