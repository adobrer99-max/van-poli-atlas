/* Canvass results: the first door-level fact the atlas holds, and the one
   input where guessing wrong is both catastrophic and invisible. */
const Canvass = require('../src/f9-canvass.js');

let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const pt = (key, label) => ({ key, label, lon: 0, lat: 0, weight: 1 });

console.log('\n== The values in the file are read, not assumed ==');
{
  const points = [pt('1 A ST', 'Strong Support'), pt('1 A ST', 'Undecided'),
                  pt('2 A ST', 'Strong Support'), pt('3 A ST', ''), pt('4 A ST', 'Refused')];
  const list = Canvass.values(points);
  eq('every distinct value comes back with its row count',
     list.map((v) => [v.value, v.rows]),
     [['Strong Support', 2], ['', 1], ['Refused', 1], ['Undecided', 1]]);
  ok('including the blanks, which are the difference between a canvass that '
     + 'covered the city and one that covered a weekend',
     list.some((v) => v.value === '' && v.rows === 1));
}

console.log('\n== Words that say their own direction are recognised ==');
{
  const list = Canvass.values([pt('a', 'Strong Support'), pt('b', 'Lean Support'),
                               pt('c', 'Undecided'), pt('d', 'Lean Against'),
                               pt('e', 'Strongly Opposed')]);
  const scale = Canvass.guess(list);
  eq('a five-point word scale lands where it should',
     ['Strong Support', 'Lean Support', 'Undecided', 'Lean Against', 'Strongly Opposed']
       .map((v) => scale.get(v)),
     [1, 0.75, 0.5, 0.25, 0]);
  const loose = Canvass.guess(Canvass.values([pt('a', 'strong_yes'), pt('b', 'SOFT NO'),
                                              pt('c', 'not sure')]));
  eq('and the same words in other clothes', [loose.get('strong_yes'), loose.get('SOFT NO'),
                                             loose.get('not sure')], [1, 0.25, 0.5]);
}

console.log('\n== Numbers are never guessed ==');
{
  /* VAN counts 1 as strong support and 5 as strong against; plenty of
     home-grown sheets count the other way. Guessing inverts the whole canvass
     -- every supporter becomes an opponent, the list ranks the doors that said
     no -- and nothing downstream can detect it, because an inverted scale is a
     perfectly well-formed scale. */
  const scale = Canvass.guess(Canvass.values(
    [pt('a', '1'), pt('b', '2'), pt('c', '3'), pt('d', '4'), pt('e', '5')]));
  eq('a 1-to-5 column comes back entirely unmapped, for the reader to assign',
     ['1', '2', '3', '4', '5'].map((v) => scale.get(v)), [null, null, null, null, null]);
}

console.log('\n== Unmapped is not zero ==');
{
  const points = [pt('1 A ST', 'Strong Support'), pt('1 A ST', 'Refused'),
                  pt('2 A ST', 'Refused'), pt('3 A ST', '')];
  const scale = Canvass.guess(Canvass.values(points));
  const pooled = Canvass.pool(points, scale);
  /* A refusal is not weak support and a blank is not opposition. Scoring
     either as 0 would rank doors that said nothing below doors that said no. */
  eq('a door with one scored contact takes that score, not an average with the refusal',
     pooled.get('1 A ST').support, 1);
  eq('a door with nothing scorable has no score at all', pooled.get('2 A ST').support, null);
  eq('and neither does a door that was never answered', pooled.get('3 A ST').support, null);
  eq('but the contacts are counted either way, because knocking is a fact about the door',
     [pooled.get('1 A ST').contacts, pooled.get('2 A ST').contacts], [2, 1]);
}

console.log('\n== A door canvassed twice averages what it said ==');
{
  const points = [pt('1 A ST', 'Strong Support'), pt('1 A ST', 'Undecided')];
  const pooled = Canvass.pool(points, Canvass.guess(Canvass.values(points)));
  eq('two electors at one door, averaged', pooled.get('1 A ST').support, 0.75);
  eq('over the contacts that were scorable', pooled.get('1 A ST').scored, 2);
}

console.log('\n== The summary counts what a campaign argues about ==');
{
  const points = [pt('a', 'Strong Support'), pt('b', 'Refused'), pt('c', ''), pt('d', '3')];
  const list = Canvass.values(points);
  const scale = Canvass.guess(list);
  const s = Canvass.summary(list, scale, Canvass.pool(points, scale));
  eq('rows, and how many of them carried a value this could score', [s.rows, s.mapped], [4, 1]);
  eq('the ones it could not, kept apart from the ones that were blank',
     [s.unmapped, s.blank], [2, 1]);
  eq('and how many doors came out with a score', [s.doors, s.scoredDoors], [4, 1]);
}

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll canvass tests passed.\n');
process.exit(fails ? 1 : 0);
