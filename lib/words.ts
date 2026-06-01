const WORDS: Record<string, string[]> = {
  Animals: [
    'elephant', 'penguin', 'crocodile', 'flamingo', 'octopus',
    'giraffe', 'chameleon', 'platypus', 'hamster', 'lobster',
    'cheetah', 'seahorse', 'peacock', 'narwhal', 'axolotl',
    'porcupine', 'armadillo', 'jellyfish', 'stingray', 'meerkat',
    'wolverine', 'toucan', 'mantis', 'sloth', 'piranha',
    'pangolin', 'capybara', 'hedgehog', 'tarantula', 'scorpion',
    'gorilla', 'lemur', 'firefly', 'walrus', 'moose',
    'hummingbird', 'baboon', 'albatross', 'wombat', 'ibis',
    'coyote', 'beetle', 'pufferfish', 'manatee', 'salamander',
    'bison', 'condor', 'tapir', 'marmot', 'caracal',
  ],
  Food: [
    'spaghetti', 'sushi', 'burrito', 'croissant', 'pretzel',
    'dumplings', 'waffle', 'lasagna', 'falafel', 'macaron',
    'taco', 'ramen', 'nachos', 'cheesecake', 'fondue',
    'baklava', 'paella', 'gyoza', 'crepe', 'hotdog',
    'pizza', 'samosa', 'churros', 'tiramisu', 'kebab',
    'donut', 'popcorn', 'pancake', 'baguette', 'empanada',
    'pho', 'biryani', 'pierogi', 'tapioca', 'brioche',
    'gelato', 'bruschetta', 'schnitzel', 'goulash', 'shakshuka',
    'ceviche', 'tamale', 'tagine', 'rendang', 'moussaka',
    'pavlova', 'stroopwafel', 'corndog', 'injera', 'katsu',
  ],
  Objects: [
    'umbrella', 'telescope', 'accordion', 'parachute', 'compass',
    'hourglass', 'typewriter', 'periscope', 'calculator', 'lantern',
    'binoculars', 'corkscrew', 'thermometer', 'metronome', 'stethoscope',
    'microscope', 'boomerang', 'chandelier', 'anchor', 'weathervane',
    'megaphone', 'barometer', 'sundial', 'abacus', 'stopwatch',
    'skateboard', 'trampoline', 'globe', 'kaleidoscope', 'dartboard',
    'sextant', 'gyroscope', 'sledgehammer', 'catapult', 'crossbow',
    'pendulum', 'locket', 'crowbar', 'harmonica', 'kazoo',
    'xylophone', 'gramophone', 'theremin', 'percolator', 'astrolabe',
    'gauntlet', 'loom', 'bellows', 'cauldron', 'vise',
  ],
  Places: [
    'volcano', 'lighthouse', 'igloo', 'pyramid', 'windmill',
    'treehouse', 'submarine', 'skyscraper', 'waterfall', 'glacier',
    'cave', 'harbour', 'canyon', 'swamp', 'observatory',
    'castle', 'barn', 'airport', 'stadium', 'library',
    'hospital', 'station', 'rooftop', 'bunker', 'tower',
    'dam', 'maze', 'graveyard', 'temple', 'aquarium',
    'greenhouse', 'colosseum', 'bridge', 'fjord', 'tundra',
    'savanna', 'catacomb', 'monastery', 'bazaar', 'dungeon',
    'tavern', 'archipelago', 'plateau', 'oasis', 'rainforest',
    'citadel', 'labyrinth', 'slum', 'galleon', 'reef',
  ],
  Actions: [
    'juggling', 'sneezing', 'surfing', 'knitting', 'yawning',
    'whistling', 'baking', 'skydiving', 'meditating', 'gardening',
    'archery', 'bowling', 'fencing', 'kayaking', 'weightlifting',
    'breakdancing', 'painting', 'climbing', 'sculpting', 'skateboarding',
    'vaulting', 'cheerleading', 'wrestling', 'snowboarding', 'paragliding',
    'spelunking', 'beekeeping', 'glassblowing', 'welding', 'jousting',
    'lassoing', 'hitchhiking', 'moonwalking', 'hurdling', 'cartwheeling',
    'sleepwalking', 'sunbathing', 'stargazing', 'beatboxing', 'limbo',
    'busking', 'whittling', 'foraging', 'abseiling', 'ironing',
    'yodelling', 'waltzing', 'crocheting', 'taxidermy', 'graffiti',
  ],
  Professions: [
    'astronaut', 'surgeon', 'detective', 'chef', 'architect',
    'firefighter', 'archaeologist', 'sommelier', 'taxidermist', 'locksmith',
    'zookeeper', 'puppeteer', 'glassblower', 'falconer', 'cartographer',
    'cryptographer', 'blacksmith', 'acrobat', 'gondolier', 'lumberjack',
    'beekeeper', 'submariner', 'auctioneer', 'chocolatier', 'chimneysweep',
    'miner', 'gravedigger', 'butcher', 'jockey', 'undertaker',
    'navigator', 'bouncer', 'warden', 'forger', 'herbalist',
    'mortician', 'shipwright', 'cobbler', 'candlemaker', 'saddler',
    'milliner', 'apothecary', 'alchemist', 'scribe', 'herald',
    'gaoler', 'archivist', 'cooper', 'thatcher', 'tinker',
  ],
}

/** All available category names. */
export const CATEGORIES = Object.keys(WORDS) as string[]

/**
 * Pick a random word, optionally restricted to a specific category.
 * Words in `excludeWords` are skipped; if the entire pool is exhausted
 * the exclude list is ignored and a fresh pick is made (auto-reset).
 */
export const pickRandomWord = (
  category?: string | null,
  excludeWords?: string[],
): { word: string; category: string } => {
  const cat =
    category && WORDS[category]
      ? category
      : CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)]
  const list = WORDS[cat]
  const excluded = new Set(excludeWords ?? [])

  const available = list.filter((w) => !excluded.has(w))
  // If every word in the category has been used, reset and pick freely.
  const pool = available.length > 0 ? available : list

  const word = pool[Math.floor(Math.random() * pool.length)]
  return { word, category: cat }
}

export default WORDS
