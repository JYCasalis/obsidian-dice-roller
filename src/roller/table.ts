import { MarkdownRenderer, Pos } from "obsidian";

import { TABLE_REGEX } from "src/utils/constants";
import { StackRoller } from ".";
import { GenericFileRoller } from "./roller";

class SubRollerResult {
    result: string;
    combinedTooltip: string;
}

export class TableRoller extends GenericFileRoller<string> {
    content: string;
    position: Pos;
    block: string;
    header: string;
    isLookup: any;
    lookupRoller: StackRoller;
    lookupRanges: [range: [min: number, max: number], option: string][];
    combinedTooltip: string = "";
    prettyTooltip: string = "";
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
        return this.prettyTooltip;
        // return this.prettify(this.combinedTooltip);
    }
    get replacer() {
        return this.result;
    }
    result: string;

    async build() {
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

    prettify(input: string): string {
        // TODO à faire avec du regex plutôt ?

        let tab = "\t";

        let tabCount = 0;
        let output:string = "";

        for (let i = 0; i < input.length; i++) {
            if (input.charAt(i) == "(") {
                tabCount++;
                output += "(\n";
                output += tab.repeat(tabCount);
            }
            else if (input.charAt(i) == ")") {
                tabCount--;
                output += "\n";
                output += tab.repeat(tabCount);
                output += ")";
            }
            else if (input.charAt(i) == ";") {
                output += ",\n";
                output += tab.repeat(tabCount);
            }
            else if (input.charAt(i) == "|" && input.charAt(i-1) == "|") {
                output += "|\n";
                output += tab.repeat(tabCount);
            }
            else {
                output += input.charAt(i);
            }
        }

        console.log("Prettified:", output);

        return output;
    }

    async getSubResult(input: string): Promise<SubRollerResult> {
        console.log(">>> getSubResult for:[", input, "]");

        let res: SubRollerResult = new SubRollerResult();
        res.result = input;

        let subTooltips: string[] = [];

        // WARN: we may receive an input that is not string (but a number). Check
        // for embeded formulas only if we can.
        if (typeof input?.matchAll === "function") {
            // Look for dice blocks: `dice: <formula>`
            const rollerPattern = /(?:\`dice:)(.*?)(?:\`)/g;
            const foundRollers = input.matchAll(rollerPattern);

            for (let foundRoller of foundRollers) {
                const formula = foundRoller[1].trim();

                // Create sub roller with formula
                const subRoller = await this.plugin.getRoller(formula, this.source);
                // Roll it
                await subRoller.roll();
                // Get sub result
                const rollerResult = await this.getSubResult(subRoller.result);

                // Replace dice block by sub result
                res.result = res.result.replace(foundRoller[0], rollerResult.result);

                // Update tooltip
                if (subRoller instanceof TableRoller) {
                    subTooltips.push(subRoller.combinedTooltip);
                }
                else {
                    const [top, bottom] = subRoller.tooltip.split("\n");
                    subTooltips.push(top + " --> " + bottom);
                }
            }
        }

        res.combinedTooltip = subTooltips.join(";");

        console.log("<<< getSubResult returns:[", res, "]");
        return res;
    }

    async getResult() {
        console.log("------------------------- EXECUTING GET RESULT -------------------------");
        console.log("original:", this.original);
        let res = [];

        let subTooltips: string[] = [];

        for (let i = 0; i < this.rolls; i++) {
            let subTooltip:string;
            let subResult: SubRollerResult;
            let selectedOption:string;

            if (this.isLookup) {
                const result = await this.lookupRoller.roll();
                const option = this.lookupRanges.find(
                    ([range]) =>
                        (range[1] === undefined && result === range[0]) ||
                        (result >= range[0] && range[1] >= result)
                );
                if (option) {
                    subTooltip = this.lookupRoller.original.trim() + " --> " + `${this.lookupRoller.resultText}${this.header ? " | " + this.header : ""}`.trim();
                    selectedOption = option[1];
                }
            }
            else {
                const options = [...this.options];
                const randomRowNumber = this.getRandomBetween(0, options.length - 1);
                // options.splice(options.indexOf(option), 1);  Was this to forbid rolling the same result twice ?
                subTooltip = options.length + " rows" + " --> " + "[row " + (randomRowNumber+1) + "]";
                selectedOption = options[randomRowNumber];
            }

            console.log("GET RESULT => option",selectedOption, " => call getSubResult");
            subResult = await this.getSubResult(selectedOption);
            res.push(subResult.result);

            if (subResult.combinedTooltip) {
                subTooltip += " > (" + subResult.combinedTooltip + ")";
            }
            subTooltips.push(subTooltip);
        }

        if (subTooltips.length == 0) {
            this.combinedTooltip = this.original;
        }
        else if (subTooltips.length == 1) {
            this.combinedTooltip = this.original + " " + subTooltips.join("");
        }
        else {
            this.combinedTooltip = this.original + " ==> (" + subTooltips.join(" ||") + ")";
        }

        this.prettyTooltip = this.prettify(this.combinedTooltip);

        console.log("GET RESULT combinedTooltip:", this.combinedTooltip);
        console.log("GET RESULT output:", res.join("||"));

        return res.join("||");
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
                console.log("From getOptions Lookup Table >>>> call getRoller for", Object.keys(table.columns)[0].split(":").pop());
                const roller = await this.plugin.getRoller(
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
