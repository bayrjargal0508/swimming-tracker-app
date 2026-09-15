/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        deepend: "#082B39", // background: deep pool water
        wall: "#b7d7ea", // cards
        shallows: "#175A73", // raised/active surfaces
        tile: "#EDF6F9", // primary text
        mist: "#8FB6C4", // secondary text
        water: "#3BC5E5", // actions, good scores
        rope: "#EF5B4C", // faults (lane-rope red)
        buoy: "#F5C951", // cautions (lane-rope yellow)
      },
      fontFamily: {
        disp: ["BarlowSemiCondensed_700Bold"],
        dispsemi: ["BarlowSemiCondensed_600SemiBold"],
        body: ["Barlow_400Regular"],
        bodymed: ["Barlow_500Medium"],
        bodysemi: ["Barlow_600SemiBold"],
      },
    },
  },
  plugins: [],
};
