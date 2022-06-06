import * as R from "https://x.nest.land/rambda@7.1.4/mod.ts";
import { fromMarkdown } from "https://esm.sh/mdast-util-from-markdown@1.2.0";
import type { Content } from "https://cdn.esm.sh/v85/@types/mdast@3.0.10/index.d.ts";
import { parse } from "https://deno.land/std@0.142.0/flags/mod.ts";

const pathJoin = R.join("/");

async function* traverse(path: string): AsyncGenerator<Deno.DirEntry> {
  for await (const entry of Deno.readDir(path)) {
    if (entry.isDirectory) {
      yield* traverse(pathJoin([path, entry.name]));
    }

    if (entry.isFile) {
      yield Object.assign(entry, { name: pathJoin([path, entry.name]) });
    }
  }
}

type Fn<A, B> = (x: A) => B;
const map = <A, B>(fn: Fn<A, B>) =>
  async function* (gen: AsyncGenerator<A>) {
    for await (const entry of gen) {
      yield fn(entry);
    }
  };
const filter = <T>(pred: Fn<T, boolean>) =>
  async function* (gen: AsyncGenerator<T>) {
    for await (const entry of gen) {
      if (pred(entry)) {
        yield entry;
      }
    }
  };
// const forEach = <T>(fn: Fn<T, void>) =>
//   async function (gen: AsyncGenerator<T>) {
//     for await (const entry of gen) {
//       fn(entry);
//     }
//   };
async function collect<T>(gen: AsyncGenerator<T>) {
  const result = [];
  for await (const entry of gen) {
    result.push(entry);
  }
  return result;
}

const pipe = <A>(value: A) => ({
  to: <B>(fn: Fn<NonNullable<A>, B>) =>
    pipe((value && fn(value as NonNullable<A>)) as B),
});

const isMarkdown = (entry: Deno.DirEntry) => entry.name.endsWith(".md");

const decode = (encoding: string) => {
  const decoder = new TextDecoder(encoding);

  return (buf: ArrayBuffer) => decoder.decode(buf);
};
const encode = (message: string) => new TextEncoder().encode(message);

const readFile = (path: string) => Deno.readFile(path);
const readText = (x: string) =>
  Promise.resolve(x).then(readFile).then(decode("utf8"));

const isHeading = R.propEq("type", "heading");
const getHeading = R.pipe(
  R.find(isHeading),
  R.path<string>(["children", 0, "value"])
  //
);

const isParagraph = R.propEq("type", "paragraph");
const getParagraph = (x: Content[]) =>
  x
    .filter(isParagraph)
    .flatMap(R.path(["children"]))
    .flatMap(R.path(["value"]))
    .filter(Boolean) as unknown[] as string[];

const isList = R.propEq("type", "list");
const getList = (x: Content[]) =>
  x
    .filter(isList)
    .flatMap(R.path(["children"]))
    .flatMap(R.path(["children"]))
    .flatMap(R.path(["children"]))
    .map(R.path(["value"]))
    .filter(Boolean) as string[];

const groupByHeading = (children: Content[]) =>
  children.reduce(
    (group, child) =>
      isHeading(child)
        ? R.append([child], group)
        : R.adjust(-1, R.append(child), group),
    [] as Content[][]
  );

const andThen =
  <A, B>(fn: Fn<A, B>) =>
  (x: Promise<A>) =>
    x.then(fn);

const POST =
  (url: string | URL) =>
  <T>(x: T) =>
    fetch(String(url), {
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
      body: JSON.stringify(x),
    }).then((res) => res.json());

const Url = (base: string) => (url: string) => new URL(url, base);

interface Receipt {
  id: string;
  title: string;
  summary: string[];
  directions: string[];
  ingredients: string[];
  notes: string[];
}

// ==========================================

const { path, url } = parse(Deno.args);

const SearchAPI = Url(url);

const sha256 = (message: string) =>
  Promise.resolve(message)
    .then(encode)
    .then((buf) => crypto.subtle.digest("SHA-256", buf))
    .then((buf) => Array.from(new Uint8Array(buf)))
    .then(R.map((b) => ("00" + b.toString(16)).slice(-2)))
    .then(R.join(""));

pipe(path)
  .to(traverse)
  .to(filter(isMarkdown))
  .to(map(R.prop("name")))
  .to(map(readText))
  .to(map(fromMarkdown))
  .to(map(R.prop("children")))
  .to(map(groupByHeading))
  .to(
    map(
      R.map(
        R.applySpec({
          heading: getHeading,
          paragraph: getParagraph,
          list: getList,
        })
      )
    )
  )
  .to(
    map(
      R.reduce((obj, { heading, list, paragraph }, index) => {
        if (index === 0 && heading) {
          obj = R.assoc("title", heading, obj);
        }

        if (index === 0 && paragraph) {
          obj = R.assoc("summary", paragraph, obj);
        }

        if (heading?.match("操作")) {
          obj = R.assoc("directions", list, obj);
        }

        if (heading?.match("必备原料和工具")) {
          obj = R.assoc("ingredients", list, obj);
        }

        if (heading?.match("附加内容")) {
          obj = R.assoc("notes", [...paragraph, ...list], obj);
        }

        return obj;
      }, {} as Partial<Receipt>)
    )
  )
  .to(collect)
  .to(
    andThen(
      R.pipe(
        R.map(async (receipt) => ({
          ...receipt,
          id: receipt.title && (await sha256(receipt.title)),
        })),
        Promise.all.bind(Promise)
      )
    )
  )
  .to(
    andThen(
      POST(
        SearchAPI("indexes/receipts/documents")
        //
      )
    )
  );
