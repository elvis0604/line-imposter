const WORDS: Record<string, string[]> = {
  Animals: [
    'elephant', 'penguin', 'crocodile', 'flamingo', 'octopus',
    'giraffe', 'chameleon', 'platypus', 'hamster', 'lobster',
    'cheetah', 'seahorse', 'peacock', 'narwhal', 'axolotl',
  ],
  Food: [
    'spaghetti', 'sushi', 'burrito', 'croissant', 'pretzel',
    'dumplings', 'waffle', 'lasagna', 'falafel', 'macaron',
    'taco', 'ramen', 'nachos', 'cheesecake', 'fondue',
  ],
  Objects: [
    'umbrella', 'telescope', 'accordion', 'parachute', 'compass',
    'hourglass', 'typewriter', 'periscope', 'calculator', 'lantern',
    'magnifying glass', 'binoculars', 'corkscrew', 'thermometer', 'metronome',
  ],
  Places: [
    'volcano', 'lighthouse', 'igloo', 'pyramid', 'windmill',
    'treehouse', 'submarine', 'skyscraper', 'waterfall', 'glacier',
    'cave', 'harbour', 'canyon', 'swamp', 'observatory',
  ],
  Actions: [
    'juggling', 'sneezing', 'surfing', 'knitting', 'yawning',
    'whistling', 'baking', 'skydiving', 'meditating', 'gardening',
    'archery', 'bowling', 'fencing', 'kayaking', 'tightrope walking',
  ],
};

/** All available category names. */
export const CATEGORIES = Object.keys(WORDS) as string[];

/** Pick a random word, optionally restricted to a specific category. */
export function pickRandomWord(category?: string | null): { word: string; category: string } {
  const cat =
    category && WORDS[category]
      ? category
      : CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
  const list = WORDS[cat];
  const word = list[Math.floor(Math.random() * list.length)];
  return { word, category: cat };
}

export default WORDS;
