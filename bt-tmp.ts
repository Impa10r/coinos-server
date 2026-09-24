import { bail, fail, Refusal } from "$lib/utils";
const c = { json: (p: any, s: number) => ({ p, s }) } as any;
const caught = (fn: () => void) => { try { fn(); } catch (e) { return e; } };

console.log("Refusal default        ->", bail(c, caught(() => fail("nope"))));
console.log("Refusal 401            ->", bail(c, caught(() => fail("Unauthorized", 401))));
console.log("Refusal 404            ->", bail(c, caught(() => fail("gone", 404))));
console.log("plain TypeError        ->", bail(c, caught(() => { (undefined as any).x.y; })));
console.log("inline string refusal  ->", bail(c, "url required"));
console.log("explicit override      ->", bail(c, "teapot", 418));
console.log("instanceof Error       ->", caught(() => fail("x")) instanceof Error, "| Refusal:", caught(() => fail("x")) instanceof Refusal);
