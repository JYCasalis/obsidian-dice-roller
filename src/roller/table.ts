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
    // rolledRowNumbers: string;
    getPath() {
        const { groups } = this.lexeme.value.match(TABLE_REGEX);

        console.log("Apply TABLE_REGEX to:", this.lexeme.value);

        const { roll = 1, link, block, header } = groups;
        if (!link || !block) throw new Error("Could not parse link.");

        this.rolls = (roll && !isNaN(Number(roll)) && Number(roll)) ?? 1;
        this.path = decodeURIComponent(link.replace(/(\[|\]|\(|\))/g, ""));
        this.block = block
            .replace(/(\^|#)/g, "")
            .trim()
            .toLowerCase();
        this.header = header;

        console.log("roll", roll, "]");
        console.log("this.rolls[", this.rolls, "]");
        console.log("this.path[", this.path, "]");
        console.log("this.block[", this.block, "]");
        console.log("this.header[", this.header, "]");

    }
    get tooltip() {
        return `${this.formulaStack}\n${this.rolledStack}`;
    }
    get replacer() {
        return this.result;
    }
    result: string;
    async build() {
        this.setTooltip();  // TODO JYC peut-être inutile.. à voir

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

    async buildOLD() {
        console.log("***** Entering TableRoller build with result:", this.result, "*****");

        // TODO JYC: might move this one too in getResult (and add multiple formulas when rolls > 1)
        this.formulaStack = this.original?.trim();

        // Moved all this inside getResult
        // if (this.lookupRoller) {
        //     // FAIT AILLEURS DU COUP this.rolledStack += `[${this.lookupRoller.result}^${this.block}${this.header ? " | " + this.header : ""}] `;
        //     //TEST this.rolledStack = `[${this.lookupRoller.result}^${this.block}${this.header ? " | " + this.header : ""}] `;
        // }
        // else {
        //     // this.rolledStack = "[row " + this.rolledRowNumbers + "] ";
        // }

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

    // JYC etape UN, on ne s'occupe QUE du résultat (i.e. les rolledStack et formulaStack viendront plus tard)
    async process(input: string): Promise<string> {
        console.log("Got input:[", input, "]");

        let res: string = input;
        
        // WARN: we may receive an input that is not string (but a number). Check
        // for embeded formulas only if we can.
        if (typeof input.matchAll === "function") {
            const rollerPattern = /(?:\`dice:)(.*?)(?:\`)/g;
            const foundRollers = input.matchAll(rollerPattern);

            for (let foundRoller of foundRollers) {
                const formula = foundRoller[1].trim();

                // Create a sub roller
                const subRoller = await this.plugin.getRoller(formula, this.source);
                const xx = await subRoller.roll();

                console.log("Found formula:", formula, " roll returned:",xx," and result is:", subRoller.result);

                // Recurs if necessary
                // /!\ result type is any, so it can be a number and there is no automatic cast to string
                const rollerResult = await this.process(subRoller.result);

                // res.push(rollerResult);
                res = res.replace(foundRoller[0], rollerResult);
            }
        }

        console.log("PROCESS received:", input, " and returned:", res);
        return res;
    }

    // TEST JYC new version
    // TODO: il vaudrait mieux gérer les espaces de façon plus consistantes non ? (entre tip, rolledStack et res... )
    async getResult() {
        let res = [];
        let tip = [];

        for (let i = 0; i < this.rolls; i++) {
            if (this.isLookup) {
                const result = await this.lookupRoller.roll();
                const option = this.lookupRanges.find(
                    ([range]) =>
                        (range[1] === undefined && result === range[0]) ||
                        (result >= range[0] && range[1] >= result)
                );
                if (option) {
                    // TODO JYC: il faut récurser option[1] qui peut contenir une formule
                    res.push(await this.process(option[1]));

                    // res.push(option[1]);
                }
                tip.push(`[${this.lookupRoller.resultText}^${this.block}${this.header ? " | " + this.header : ""}] `);
            }
            else {
                const options = [...this.options];
                // let randomRows: string[] = [];

                const randomRowNumber = this.getRandomBetween(0, options.length - 1);
                tip.push((randomRowNumber+1).toString());
                let option = options[randomRowNumber];
                options.splice(options.indexOf(option), 1);
                // TODO JYC: il faut récurser option qui peut contenir une formule
                res.push(await this.process(option));
                // res.push(option);
            }
        }

        this.rolledStack = tip.join("|| ");
        // pas besoin de cas special pour non lookup ? this.rolledStack = "[row " + randomRows.join("||") + "] ";

        console.log("GET RESULT output:", res.join("||"));
        return res.join("||");
    }

    // OLD version
    async getResult2() {
        // TODO JYC: might also fill this.stackFormula initial value here

        // Le problème maintenant, avec le cas multi roll qui affiche des résultats séparés par || est
        // que... si le résultat est un autre roller... bah il ne "s'insère" pas forcément au bon endroit
        // par rapport aux ||
        // Ex:  2d[[x^repeat]] ~ 1d4+2 ~ 1d4+2
        //      [[10]^repeat] || [[9]^repeat] ~[4] + 2 ~ [3] + 2
        //
        // Je pense qu'il n'y a pas trop le choix, il faut faire un parcours différent
        // des formules
        // Au lieu de while (there is a formula)
        // Il faut "descendre" dans les remplacements chaque fois que l'on en fait un
        // init :
        //      f1 -- f2
        //          f1 -> f'1 , f'2
        //                f'1 <- v1
        //             -> v1 , f'2
        //                f'2 <- v2
        //             <- v1, v2
        //      v1, v2 -- f2
        //          f2 -> v3
        //             <- v3
        //      v1, v2 -- v3
        //
        //  Donc un truc du genre:
        //  process(formula) {
        //      while (formula) {
        //          process(formula) => return "final result" + tooltip
        //      }
        //  }
        //  res, tootlip = process(formula);
        //  set result and tooltip
        // (i.e. ne pas modifier/utiliser this.result pendant la recursion)
        //
        // Pour gérer les séparateurs, utiliser un join qui fera le boulot de ne pas en mettre après
        // le dernier.
        // Donc, en gros, on ne fait pas de xx += yy mais on push dans un Array qu'on join à la fin
        // avec le séparateur adhoc ("||"" pour le nb rolls devant le table roller, "," quand on a
        // n formules, ">" quand on arrive dans process). Attention, le cas ">" est probablement différent
        //
        // En attendant, essayons de comprendre le flot complet... quid de getResult vs load vs build
        //
        // roll() appelle getResult (qui devrait s'appeler computeResult)
        //            puis render qui lui appelle setTooltip et build
        // mouais....
        //
        // load lui, appelle getOptions
        //    qui créé un lookupRoller si le header de la première colonne contient "dice:"
        //    et positionne isLookup a true
        // Si pas de "dice:" dans le header, c'est pas une lookup table et on n'a donc pas de lookupRoller
        //
        // Pour load et applyResult, ça doit venir de la persistence
        // Dans main on trouve:
        //      if (roller.loaded) {
        //          await load();
        //      } else {
        //          roller.on("loaded", async () => {
        //              await load();
        //          });
        //      }
        // load étant une callback définie de la façon suivante:
        //      const load = async () => {
        //          if (roller.save && savedResult) {
        //              await roller.applyResult(savedResult);
        //          }
        //          node.replaceWith(roller.containerEl);
        //      }

        if (this.isLookup) {
            // JYC: on-going... not pretty for now...
            // Support multiple rolls even if lookup table
            let res = [];
            let tip = [];

            for (let i = 0; i < this.rolls; i++) {
                const result = await this.lookupRoller.roll();
                console.log("lookupRoller.result:", this.lookupRoller.result);
                console.log("lookupRoller.resultText:", this.lookupRoller.resultText);
                console.log("result:", result);
                const option = this.lookupRanges.find(
                    ([range]) =>
                        (range[1] === undefined && result === range[0]) ||
                        (result >= range[0] && range[1] >= result)
                );
                if (option) {
                    res.push(option[1]);
                }
                tip.push(`[${this.lookupRoller.resultText}^${this.block}${this.header ? " | " + this.header : ""}] `);
            }

            // tip.pop();
            this.rolledStack = tip.join("|| ");
            console.log("GET RESULT output (lookup case):", res.join("||"));
            return res.join("||");

            // JYC: version originale
            // const result = await this.lookupRoller.roll();
            // const option = this.lookupRanges.find(
            //     ([range]) =>
            //         (range[1] === undefined && result === range[0]) ||
            //         (result >= range[0] && range[1] >= result)
            // );
            // if (option) {
            //     return option[1];
            // }
        }
        const options = [...this.options];
        let randomRows: string[] = [];
        let res = [];
        for (let i = 0; i < this.rolls; i++) {
            const randomRowNumber = this.getRandomBetween(0, options.length - 1);
            randomRows.push((randomRowNumber+1).toString());
            let option = options[randomRowNumber];
            options.splice(options.indexOf(option), 1);
            res.push(option);
        }

        // Original
        // let res = [...Array(this.rolls)]
        //     .map(() => {
        //         const randomRowNumber = this.getRandomBetween(0, options.length - 1);
        //         randomRows.push((randomRowNumber+1).toString());
        //         let option = options[randomRowNumber];
        //         options.splice(options.indexOf(option), 1);
        //         return option;
        //     })
        //     .join("||");
        // this.rolledRowNumbers = randomRows.join("||");

        this.rolledStack = "[row " + randomRows.join("||") + "] ";
        console.log("GET RESULT output (non lookup case):", res.join("||"));
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
