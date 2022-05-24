import { MarkdownRenderer, Pos } from "obsidian";

import { TABLE_REGEX } from "src/utils/constants";
import { StackRoller } from ".";
import { GenericFileRoller } from "./roller";

export class TableRoller extends GenericFileRoller<string> {
    content: string;
    position: Pos;
    block: string;
    header: string;
    isLookup: any;
    lookupRoller: StackRoller;
    lookupRanges: [range: [min: number, max: number], option: string][];
    formulaStack: string = "";
    rolledStack: string = "";
    rolledRowNumbers: string;
    getPath() {
        const { groups } = this.lexeme.value.match(TABLE_REGEX);

        const { roll = 1, link, block, header } = groups;
        if (!link || !block) throw new Error("Could not parse link.");

        this.rolls = (roll && !isNaN(Number(roll)) && Number(roll)) ?? 1;
        this.path = decodeURIComponent(link.replace(/(\[|\]|\(|\))/g, ""));
        this.block = block
            .replace(/(\^|#)/g, "")
            .trim()
            .toLowerCase();
        this.header = header;
    }
    get tooltip() {
        return `${this.formulaStack}\n${this.rolledStack}`;
    }
    get replacer() {
        return this.result;
    }
    result: string;
    async build() {
        console.log("***** Entering TableRoller build with result:", this.result, "*****");

        this.formulaStack = this.original;
        if (this.lookupRoller) {
            this.rolledStack = `[${this.lookupRoller.result}^${this.block}${this.header ? " | " + this.header : ""}] `;
        }
        else {
            this.rolledStack = "[row " + this.rolledRowNumbers + "] ";
        }

        let rollerPattern = /(?:\`dice:)(.*?)(?:\`)/;
        let foundRoller;

        let i = 0;

        while ((foundRoller = this.result.match(rollerPattern)) != null) {
            const formula = foundRoller[1].trim();

            console.log("Processing formula #", i, ":", formula);
            console.log("----------------------");

            // Create a sub roller
            const subRoller = await this.plugin.getRoller(formula, this.source);
            await subRoller.roll();

            // Aggregate tooltip
            const [top, bottom] = subRoller.tooltip.split("\n");
            this.formulaStack += " ~ " + top;
            this.rolledStack += " ~ " + bottom;
            console.log("NESTED ==> updated formulaStack:", this.formulaStack);
            console.log("NESTED ==> updated rolledStack:", this.rolledStack);

            // Aggregate result
            console.log("Updated result from", this.result, "to", this.result.replace(foundRoller[0], subRoller.result));
            this.result = this.result.replace(foundRoller[0], subRoller.result);

            // TEMP security infinite loop
            i++;
            if (i > 20) {
                console.log("INFINITE LOOP, FORCE EXIT....");
                break;
            }
        };

        console.log("=============================");
        console.log("FINAL RESULT is:", this.result);
        console.log("FINAL TOOLTIP is:", this.formulaStack+"\n"+this.rolledStack);
        console.log("=============================");

        this.setTooltip();

        this.resultEl.empty();
        let result = [this.result];
        if (this.plugin.data.displayResultsInline) {
            result.unshift(this.inlineText);
        }
        MarkdownRenderer.renderMarkdown(
            result.join(""),
            this.resultEl.createSpan("embedded-table-result"),
            this.source,
            null
        );
    }

    async getResult() {
        if (this.isLookup) {
            const result = await this.lookupRoller.roll();
            const option = this.lookupRanges.find(
                ([range]) =>
                    (range[1] === undefined && result === range[0]) ||
                    (result >= range[0] && range[1] >= result)
            );
            if (option) {
                return option[1];
            }
        }
        const options = [...this.options];
        let randomRows: string[] = [];
        let res = [...Array(this.rolls)]
            .map(() => {
                const randomRowNumber = this.getRandomBetween(0, options.length - 1);
                randomRows.push((randomRowNumber+1).toString());
                let option = options[randomRowNumber];
                options.splice(options.indexOf(option), 1);
                return option;
            })
            .join("||");
        this.rolledRowNumbers = randomRows.join("||");

        return res;
    }
    async roll(): Promise<string> {
        return new Promise(async (resolve) => {
            if (this.loaded) {
                this.result = await this.getResult();

                this.render();

                this.trigger("new-result");
                resolve(this.result);
            } else {
                this.on("loaded", async () => {
                    this.result = await this.getResult();

                    this.render();

                    this.trigger("new-result");
                    resolve(this.result);
                });
            }
        });
    }
    async load() {
        await this.getOptions();
    }

    async getOptions() {
        this.cache = this.plugin.app.metadataCache.getFileCache(this.file);

        if (
            !this.cache ||
            !this.cache.blocks ||
            !(this.block in this.cache.blocks)
        ) {
            throw new Error(
                "Could not read file cache. Does the block reference exist?\n\n" +
                    `${this.path} > ${this.block}`
            );
        }

        const section = this.cache.sections?.find(
            (s) => s.position == this.cache.blocks[this.block].position
        );
        this.position = this.cache.blocks[this.block].position;
        this.content = (
            await this.plugin.app.vault.cachedRead(this.file)
        )?.slice(this.position.start.offset, this.position.end.offset);

        if (section && section.type === "list") {
            this.options = this.content.split("\n");
        } else {
            let table = extract(this.content);

            /** Check for Lookup Table */
            if (
                Object.keys(table.columns).length === 2 &&
                /dice:\s*([\s\S]+)\s*?/.test(Object.keys(table.columns)[0])
            ) {
                console.log("JYC - from getOptions Lookup Table >>>> call getRoller for", Object.keys(table.columns)[0].split(":").pop());
                const roller = await this.plugin.getRoller( // JYC
                    Object.keys(table.columns)[0].split(":").pop(),
                    this.source
                );
                if (roller instanceof StackRoller) {
                    this.lookupRoller = roller;
                    // TODO JYC: useless roll I think
                    // let result = await this.lookupRoller.roll();

                    this.lookupRanges = table.rows.map((row) => {
                        const [range, option] = row
                            .replace(/\\\|/g, "{ESCAPED_PIPE}")
                            .split("|")
                            .map((str) => str.replace(/{ESCAPED_PIPE}/g, "\\|"))
                            .map((s) => s.trim());

                        let [, min, max] =
                            range.match(/(\d+)(?:[^\d]+?(\d+))?/) ?? [];

                        if (!min && !max) return;
                        return [
                            [Number(min), max ? Number(max) : undefined],
                            option
                        ];
                    });
                    this.isLookup = true;
                }
            }
            if (this.header && table.columns[this.header]) {
                this.options = table.columns[this.header];
            } else {
                if (this.header) {
                    throw new Error(
                        `Header ${this.header} was not found in table ${this.path} > ${this.block}.`
                    );
                }
                this.options = table.rows;
            }
        }

        this.loaded = true;
        this.trigger("loaded");
    }
    toResult() {
        return {
            type: "table",
            result: this.result
        };
    }
    async applyResult(result: any) {
        if (result.type !== "table") return;
        if (result.result) {
            this.result = result.result;
        }
        await this.render();
    }
}
const MATCH = /^\|?([\s\S]+?)\|?$/;
const SPLIT = /\|/g;

function extract(content: string) {
    const lines = content.split("\n");

    const inner = lines.map((l) => (l.trim().match(MATCH) ?? [, l.trim()])[1]);

    const headers = inner[0].replace("\\|", "{ESCAPED_PIPE}").split(SPLIT);

    const rows: string[] = [];
    const ret: [string, string[]][] = [];

    for (let index in headers) {
        let header = headers[index];
        if (!header.trim().length) header = index;
        ret.push([header.trim(), []]);
    }

    for (let line of lines.slice(2)) {
        const entries = line
            .trim()
            .replace(/\\\|/g, "{ESCAPED_PIPE}")
            .split(SPLIT)
            .map((e) => e.replace(/{ESCAPED_PIPE}/g, "\\|"))
            .map((e) => e.trim())
            .filter((e) => e.length);

        rows.push(entries.join(" | "));

        for (let index in entries) {
            const entry = entries[index].trim();
            if (!entry.length || !ret[index]) continue;
            ret[index][1].push(entry);
        }
    }
    return {
        columns: Object.fromEntries(ret),
        rows: rows
    };
}
