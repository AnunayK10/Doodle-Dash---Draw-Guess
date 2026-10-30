const categories: Record<string, string[]> = {
  animals: ["koala", "octopus", "giraffe", "hedgehog", "penguin", "butterfly", "dolphin", "chameleon"],
  objects: ["umbrella", "telescope", "backpack", "hourglass", "toothbrush", "skateboard", "lantern", "key"],
  food: ["pancake", "watermelon", "popcorn", "cupcake", "pineapple", "pretzel", "sushi", "ice cream"],
  nature: ["volcano", "rainbow", "cactus", "waterfall", "sunflower", "snowflake", "lightning", "mushroom"],
  actions: ["juggling", "sleepwalking", "surfing", "whistling", "breakdancing", "sneezing", "fishing", "gardening"],
};

const combinations = [
  "moon landing",
  "ice cream truck",
  "haunted house",
  "paper airplane",
  "camping trip",
  "space station",
  "treasure chest",
  "sleeping bag",
  "hot air balloon",
  "roller coaster",
  "birthday cake",
  "robot dog",
];

export function chooseWords(count: number, mode: "normal" | "hidden" | "combination"): string[] {
  const source = mode === "combination" ? combinations : Object.values(categories).flat();
  const shuffled = [...source].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

export function getHint(word: string, revealed: number): string {
  let hidden = 0;
  return [...word].map((character) => {
    if (!/[a-z0-9]/i.test(character)) return character;
    if (hidden < revealed) {
      hidden += 1;
      return character;
    }
    hidden += 1;
    return "_";
  }).join(" ");
}
