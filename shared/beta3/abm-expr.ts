/**
 * ActivitySim's utility expressions (pandas syntax, as written in the prototype_mtc configs),
 * compiled to functions of named variables. Python's precedence is kept: comparisons bind more
 * loosely than `|` and `&`, so the configs parenthesise them.
 *
 * Expected values: the model applies each expression to segments of people, where a "flag" may be a
 * share (the share of the segment that is female, the probability that a child stays home). So `&`
 * is a product, `|` is a + b − ab, and `~` is 1 − x: for 0/1 values these are the boolean
 * operators, and for shares they are the expected values when the parts are independent. A
 * comparison of a variable with a number, such as `distance_to_work < 3`, is looked up first as a
 * variable of that name (`distance_to_work<3`), which carries the probability for a segment.
 */
export type Vars = Record<string, number>;
export type Fn = (v: Vars) => number;

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function lex(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const m2 = s.slice(i, i + 2);
    if (['==', '!=', '>=', '<='].includes(m2)) {
      out.push({ t: 'op', v: m2 });
      i += 2;
      continue;
    }
    if ('()&|~*+-<>/'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(s.slice(i));
    if (num) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z_0-9.]*/.exec(s.slice(i));
    if (id) {
      out.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    throw new Error(`cannot read "${s}" at ${i}`);
  }
  return out;
}

/** the expression's tree: a variable, a number, or an operator on its operands */
export type Ast = { k: 'var'; name: string } | { k: 'num'; v: number } | { k: 'op'; op: string; a: Ast; b?: Ast };

export function parse(s: string): Ast {
  const T = lex(s);
  let p = 0;
  const peek = () => T[p];
  const isOp = (v: string) => peek()?.t === 'op' && peek().v === v;
  // comparison < | < & < + - < * / < unary
  const cmp = (): Ast => {
    let a = or();
    while (peek()?.t === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(peek().v as string)) {
      const op = T[p++].v as string;
      a = { k: 'op', op, a, b: or() };
    }
    return a;
  };
  const or = (): Ast => {
    let a = and();
    while (isOp('|')) (p++, (a = { k: 'op', op: '|', a, b: and() }));
    return a;
  };
  const and = (): Ast => {
    let a = add();
    while (isOp('&')) (p++, (a = { k: 'op', op: '&', a, b: add() }));
    return a;
  };
  const add = (): Ast => {
    let a = mul();
    while (isOp('+') || isOp('-')) {
      const op = T[p++].v as string;
      a = { k: 'op', op, a, b: mul() };
    }
    return a;
  };
  const mul = (): Ast => {
    let a = un();
    while (isOp('*') || isOp('/')) {
      const op = T[p++].v as string;
      a = { k: 'op', op, a, b: un() };
    }
    return a;
  };
  const un = (): Ast => {
    if (isOp('~')) return p++, { k: 'op', op: '~', a: un() };
    if (isOp('-')) {
      p++;
      const a = un();
      return a.k === 'num' ? { k: 'num', v: -a.v } : { k: 'op', op: 'neg', a };
    }
    if (isOp('(')) {
      p++;
      const a = cmp();
      if (!isOp(')')) throw new Error(`missing ) in "${s}"`);
      p++;
      return a;
    }
    const t = T[p++];
    if (!t) throw new Error(`unexpected end of "${s}"`);
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'id') return t.v === 'True' ? { k: 'num', v: 1 } : t.v === 'False' ? { k: 'num', v: 0 } : { k: 'var', name: t.v };
    throw new Error(`unexpected ${t.v} in "${s}"`);
  };
  const a = cmp();
  if (p !== T.length) throw new Error(`trailing tokens in "${s}"`);
  return a;
}

const CMP: Record<string, (x: number, y: number) => boolean> = {
  '==': (x, y) => x === y,
  '!=': (x, y) => x !== y,
  '<': (x, y) => x < y,
  '>': (x, y) => x > y,
  '<=': (x, y) => x <= y,
  '>=': (x, y) => x >= y,
};

/** a function of the variables; a variable not given counts as 0 */
export function compileAst(a: Ast): Fn {
  if (a.k === 'num') {
    const v = a.v;
    return () => v;
  }
  if (a.k === 'var') {
    const n = a.name;
    return (v) => v[n] ?? 0;
  }
  const x = compileAst(a.a),
    y = a.b ? compileAst(a.b) : null;
  switch (a.op) {
    case '~':
      return (v) => 1 - x(v);
    case 'neg':
      return (v) => -x(v);
    case '&':
    case '*':
      return (v) => x(v) * y!(v);
    case '/':
      return (v) => x(v) / y!(v);
    case '+':
      return (v) => x(v) + y!(v);
    case '-':
      return (v) => x(v) - y!(v);
    case '|':
      return (v) => {
        const p = x(v),
          q = y!(v);
        return p + q - p * q;
      };
  }
  const f = CMP[a.op];
  if (!f) throw new Error(`operator ${a.op}`);
  // a variable compared with a number may be given as a probability under the comparison's name
  if (a.a.k === 'var' && a.b!.k === 'num') {
    const key = `${a.a.name}${a.op}${a.b!.v}`,
      n = a.a.name,
      c = a.b!.v;
    return (v) => (key in v ? v[key] : f(v[n] ?? 0, c) ? 1 : 0);
  }
  return (v) => (f(x(v), y!(v)) ? 1 : 0);
}

export const compile = (s: string): Fn => compileAst(parse(s));

/** the variables an expression reads */
export function varsOf(a: Ast, out = new Set<string>()): Set<string> {
  if (a.k === 'var') out.add(a.name);
  else if (a.k === 'op') {
    varsOf(a.a, out);
    if (a.b) varsOf(a.b, out);
  }
  return out;
}

/**
 * An expression as a product of a part that reads only `left` variables and a part that reads none
 * of them (its factors at the top level of `&` and `*`), so a utility term can be split into what
 * depends on the alternative and what depends on the person. Throws if a factor reads both.
 */
export function factor(s: string, left: Set<string>): { left: string; right: string } {
  const a = parse(s);
  const fs: Ast[] = [];
  const walk = (x: Ast) => {
    if (x.k === 'op' && (x.op === '&' || x.op === '*')) (walk(x.a), walk(x.b!));
    else fs.push(x);
  };
  walk(a);
  const L: Ast[] = [],
    R: Ast[] = [];
  for (const f of fs) {
    const vs = [...varsOf(f)];
    const inL = vs.filter((v) => left.has(v)).length;
    if (inL && inL < vs.length) throw new Error(`"${s}" mixes the alternative and the person in one factor`);
    (inL ? L : R).push(f);
  }
  const str = (xs: Ast[]) => (xs.length ? xs.map(show).join(' * ') : '1');
  return { left: str(L), right: str(R) };
}

function show(a: Ast): string {
  if (a.k === 'num') return String(a.v);
  if (a.k === 'var') return a.name;
  if (a.op === '~') return `~(${show(a.a)})`;
  if (a.op === 'neg') return `-(${show(a.a)})`;
  return `(${show(a.a)} ${a.op} ${show(a.b!)})`;
}
