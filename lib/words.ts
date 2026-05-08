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

/** Pick a random word from the full word bank. */
export function pickRandomWord(): { word: string; category: string } {
  const categories = Object.keys(WORDS);
  const category = categories[Math.floor(Math.random() * categories.length)];
  const list = WORDS[category];
  const word = list[Math.floor(Math.random() * list.length)];
  return { word, category };
}

export default WORDS;
