export function SpaceArt({ id = 'space' }: { id?: string }) {
  return (
    <svg
      className="space-art"
      viewBox="0 0 600 340"
      preserveAspectRatio="xMidYMid slice"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id={`${id}-bg`}
          x1="0"
          y1="0"
          x2="600"
          y2="340"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#24344d" />
          <stop offset=".5" stopColor="#1c2540" />
          <stop offset="1" stopColor="#38304d" />
        </linearGradient>
        <linearGradient
          id={`${id}-planet`}
          x1="320"
          y1="90"
          x2="450"
          y2="250"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#e7ccb0" />
          <stop offset=".48" stopColor="#c6a5b2" />
          <stop offset="1" stopColor="#746e9a" />
        </linearGradient>
        <radialGradient id={`${id}-glow`}>
          <stop stopColor="#97e8c5" stopOpacity=".22" />
          <stop offset="1" stopColor="#97e8c5" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path fill={`url(#${id}-bg)`} d="M0 0h600v340H0z" />
      <ellipse cx="230" cy="240" rx="280" ry="230" fill={`url(#${id}-glow)`} />
      {Array.from({ length: 42 }, (_, i) => (
        <rect
          key={i}
          x={(i * 137 + 27) % 580}
          y={(i * 61 + 13) % 320}
          width={i % 4 === 0 ? 3 : 1.5}
          height={i % 4 === 0 ? 3 : 1.5}
          fill={i % 3 === 0 ? '#a5eccb' : '#eeece4'}
          opacity={0.3 + (i % 5) * 0.13}
        />
      ))}
      <circle cx="408" cy="153" r="82" fill={`url(#${id}-planet)`} />
      <path
        d="M339 108c42 3 96 37 141 64M329 136c41 5 98 42 135 64M346 196c22-1 51 17 72 36"
        stroke="#eee0cd"
        strokeWidth="8"
        opacity=".15"
      />
      <ellipse
        cx="406"
        cy="156"
        rx="137"
        ry="31"
        transform="rotate(-25 406 156)"
        stroke="#d6d3c2"
        strokeOpacity=".5"
        strokeWidth="13"
      />
      <path d="m193 188 4 24 37 24-27-42-14-6Z" fill="#a9efc8" />
      <path d="m193 188-19 17 6 44 17-37-4-24Z" fill="#71a9a7" />
      <path d="m193 188 4 24-17 37 10-53 3-8Z" fill="#e2f4db" />
      <path d="m180 236-11 37 20-31" fill="#eaca9f" />
      <path d="m176 253-14 36" stroke="#eaca9f" strokeOpacity=".4" strokeWidth="2" />
      <path d="m70 65 3 8 8 3-8 3-3 8-3-8-8-3 8-3 3-8Z" fill="#c8efd6" />
    </svg>
  )
}

export function HandheldArt() {
  return (
    <div className="handheld-scene" aria-hidden="true">
      <div className="orbit orbit-one" />
      <div className="orbit orbit-two" />
      <span className="scene-spark spark-one">✧</span>
      <span className="scene-spark spark-two">+</span>
      <span className="scene-spark spark-three">✧</span>
      <div className="handheld-shadow" />
      <div className="handheld">
        <div className="shoulder shoulder-left" />
        <div className="shoulder shoulder-right" />
        <div className="handheld-label">ORBITRA</div>
        <div className="console-dpad">
          <span />
          <span />
        </div>
        <div className="handheld-screen">
          <SpaceArt id="console" />
          <div className="pixel-title">
            STAR
            <br />
            <b>ORBIT</b>
          </div>
          <span className="screen-start">PRESS START</span>
          <span className="screen-brand">GAME BOY ADVANCE</span>
        </div>
        <div className="power-led" />
        <div className="console-ab">
          <i>B</i>
          <i>A</i>
        </div>
        <div className="console-options">
          <i />
          <i />
        </div>
        <div className="speaker-lines">
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
      <div className="art-caption">
        <span /> A little nostalgia. A lot of possibility.
      </div>
    </div>
  )
}
