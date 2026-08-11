/** Ambient centered greeting shown over the home canvas. */
export function Greeting() {
  return (
    <div className="pointer-events-none fixed inset-0 z-20 flex flex-col items-center justify-center">
      <h1 className="pointer-events-auto mb-[80vh] text-center text-3xl font-light text-white/90">
        Good Morning! <br />
        How can I help you today?
      </h1>
    </div>
  );
}

export default Greeting;
