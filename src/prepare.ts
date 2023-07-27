import {readdir, stat} from "fs/promises";
import {join as pathJoin} from "path";
import * as z from "zod";
import chalk from "chalk";

const buildSchema = z.object({
    board_env: z.string().min(1),
    include: z.string().min(1).or(z.array(z.string().min(1))).optional(),
    active: z.boolean().optional(),
    only: z.literal("stable").or(z.literal("nightly")).optional(),
    min_version: z.string().optional(),
    meta: z.object({
        stable_name: z.string().min(1),
        nightly_name: z.string().min(1)
    }),
    based_on: z.object({
        repo: z.string().min(1),
        path: z.string().min(1),
        stable_branch: z.string().min(1),
        nightly_branch: z.string().min(1)
    }),
    configuration: z.object({
        enable: z.array(z.string().min(1).or(z.tuple([z.string().min(1), z.unknown()]))).default(() => []),
        disable: z.array(z.string().min(1)).default(() => [])
    }).default(() => ({enable: [], disable: []})),
    configuration_adv: z.object({
        enable: z.array(z.string().min(1).or(z.tuple([z.string().min(1), z.unknown()]))).default(() => []),
        disable: z.array(z.string().min(1)).default(() => [])
    }).default(() => ({enable: [], disable: []}))
});

//extended builds can inherit every property except the meta names
//they can also extend other builds themselves
const extendedBuildSchema = buildSchema.deepPartial().extend({
    extends: z.string().min(1).or(z.array(z.string().min(1))),
    meta: z.object({
        stable_name: z.string().min(1),
        nightly_name: z.string().min(1)
    }),
    //have to redefine these so the default takes precedence over the deepPartial
    configuration: z.object({
        enable: z.array(z.string().min(1).or(z.tuple([z.string().min(1), z.unknown()]))).default(() => []),
        disable: z.array(z.string().min(1)).default(() => [])
    }).default(() => ({enable: [], disable: []})),
    configuration_adv: z.object({
        enable: z.array(z.string().min(1).or(z.tuple([z.string().min(1), z.unknown()]))).default(() => []),
        disable: z.array(z.string().min(1)).default(() => [])
    }).default(() => ({enable: [], disable: []}))
});

//partial builds only have the configurations
//they can also include other partials
const partialBuildSchema = buildSchema.pick({configuration: true, configuration_adv: true}).extend({
    partial: z.literal(true),
    include: z.string().min(1).or(z.array(z.string().min(1))).optional()
});

export type BuildSchema = z.infer<typeof buildSchema>;
type ExtendedBuildSchema = z.infer<typeof extendedBuildSchema>;
type PartialBuildSchema = z.infer<typeof partialBuildSchema>;
type AnyBuildSchema = BuildSchema | ExtendedBuildSchema | PartialBuildSchema;

export async function loadBuilds() {
    const builds: string[] = [];
    await getBuildPaths(builds, "./builds");
    const preLoaded: {[key: string]: unknown} = {};
    const loaded: {[key: string]: BuildSchema} = {};

    //load the build files
    for (const build of builds) {
        let loadedBuild = require(`../${build}`);
        if (typeof loadedBuild === "function") {
            loadedBuild = await loadedBuild();
        }
        preLoaded[build] = loadedBuild;
    }

    //preparse
    const preParsed = preparseBuilds(preLoaded);

    //merge partial builds directly everywhere they are included
    const partials: string[] = [];
    for (const [buildName, builder] of Object.entries(preParsed)) {
        if (!builder.build.include) continue;
        if (Array.isArray(builder.build.include)) {
            for (const partialBuildName of builder.build.include) {
                if (!builds.includes(partialBuildName)) {
                    throw new Error(`Invalid build ${buildName}, partial ${partialBuildName} does not exist`);
                }
                const partialBuilder = preParsed[partialBuildName];
                if (partialBuilder.kind !== "partial") {
                    throw new Error(`Invalid build ${buildName}, included ${partialBuildName} is not a partial`);
                }
                fixConfigurationConflicts(partialBuilder.build, builder.build, partialBuildName, buildName, "configuration");
                mergePartialConfiguration(builder.build, partialBuilder.build, "configuration");
                fixConfigurationConflicts(partialBuilder.build, builder.build, partialBuildName, buildName, "configuration_adv");
                mergePartialConfiguration(builder.build, partialBuilder.build, "configuration_adv");
                if (!partials.includes(partialBuildName)) partials.push(partialBuildName);
            }
        } else {
            if (!builds.includes(builder.build.include)) {
                throw new Error(`Invalid build ${buildName}, partial ${builder.build.include} does not exist`);
            }
            const partialBuilder = preParsed[builder.build.include];
            if (partialBuilder.kind !== "partial") {
                throw new Error(`Invalid build ${buildName}, included ${builder.build.include} is not a partial`);
            }
            fixConfigurationConflicts(partialBuilder.build, builder.build, builder.build.include, buildName, "configuration");
            mergePartialConfiguration(builder.build, partialBuilder.build, "configuration");
            fixConfigurationConflicts(partialBuilder.build, builder.build, builder.build.include, buildName, "configuration_adv");
            mergePartialConfiguration(builder.build, partialBuilder.build, "configuration_adv");
            if (!partials.includes(builder.build.include)) partials.push(builder.build.include);
        }
    }

    //merge extended builds
    for (const [buildName, builder] of Object.entries(preParsed)) {
        if (builder.kind !== "extended") continue;
        if (Array.isArray(builder.build.extends)) {
            for (const ex of builder.build.extends) {
                if (!builds.includes(ex)) {
                    throw new Error(`Invalid extension build ${buildName}, extended ${ex} does not exist`);
                }
                if (preParsed[ex].kind === "partial") {
                    throw new Error(`Invalid extension build ${buildName}, extended ${ex} is a partial`);
                }
            }
        } else {
            if (!builds.includes(builder.build.extends)) {
                throw new Error(`Invalid extension build ${buildName}, extended ${builder.build.extends} does not exist`);
            }
            if (preParsed[builder.build.extends].kind === "partial") {
                throw new Error(`Invalid extension build ${buildName}, extended ${builder.build.extends} is a partial`);
            }
        }
        mergeExtension(<PreParsedNoPartials>preParsed, buildName, builder.build);
    }

    //delete the partials
    for (const partial of partials) {
        delete preParsed[partial];
    }

    //fix self-conflicts and do another parse
    for (const [buildName, builder] of Object.entries(preParsed)) {
        fixConfigurationConflicts(builder.build, builder.build, builder.name, builder.name, "configuration");
        fixConfigurationConflicts(builder.build, builder.build, builder.name, builder.name, "configuration_adv");
        try {
            buildSchema.parse(builder.build);
        } catch (err) {
            if (err instanceof z.ZodError) {
                throw new Error(`Invalid build ${buildName} -> ${err.issues[0].path[0]} -> ${err.issues[0].message}`);
            } else {
                throw new Error(`Invalid build ${buildName}`);
            }
        }
        loaded[buildName] = <BuildSchema>builder.build;
    }

    //check unique asset names
    for (const build of Object.values(loaded)) {
        if (Object.values(loaded).filter(l => l.meta.stable_name === build.meta.stable_name).length > 1) {
            throw new Error(`Asset name ${build.meta.stable_name} is used by more than 1 build`);
        }
        if (Object.values(loaded).filter(l => l.meta.nightly_name === build.meta.nightly_name).length > 1) {
            throw new Error(`Asset name ${build.meta.nightly_name} is used by more than 1 build`);
        }
    }

    return loaded;
}

async function getBuildPaths(builds: string[], path: string) {
    const files = await readdir(path);
    for (const file of files) {
        const buildPath = pathJoin(path, file);
        const st = await stat(buildPath);
        if (st.isDirectory()) {
            await getBuildPaths(builds, buildPath);
        } else {
            builds.push(buildPath);
        }
    }
}

type PreParsed = {
    [key: string]: {
        kind: "partial",
        build: PartialBuildSchema,
        name: string
    } | {
        kind: "extended",
        build: ExtendedBuildSchema,
        name: string
    } | {
        kind: "full",
        build: BuildSchema,
        name: string
    }
};
type PreParsedNoPartials = {
    [key: string]: {
        kind: "extended",
        build: ExtendedBuildSchema,
        name: string
    } | {
        kind: "full",
        build: BuildSchema,
        name: string
    }
};
function preparseBuilds(preLoaded: {[key: string]: unknown}): PreParsed {
    return Object.fromEntries(Object.entries(preLoaded).map(function([buildName, build]) {
        try {
            if (typeof build === "object" && build !== null && "partial" in build) {
                const parsed = partialBuildSchema.parse(build);
                return [buildName, {kind: "partial", build: parsed, name: buildName}];
            } else if (typeof build === "object" && build !== null && "extends" in build) {
                const parsed = extendedBuildSchema.parse(build);
                return [buildName, {kind: "extended", build: parsed, name: buildName}];
            } else {
                const parsed = buildSchema.parse(build);
                return [buildName, {kind: "full", build: parsed, name: buildName}];
            }
        } catch (err) {
            if (err instanceof z.ZodError) {
                throw new Error(`Invalid build ${buildName} -> ${err.issues[0].path[0]} -> ${err.issues[0].message}`);
            } else {
                throw new Error(`Invalid build ${buildName}`);
            }
        }
    }));
}

function mergeExtension(preParsed: PreParsedNoPartials, buildName: string, build: ExtendedBuildSchema) {
    if (Array.isArray(build.extends)) {
        //merge all parents in defined order
        let initial: PreParsedNoPartials[string] | null = null;
        for (const ex of build.extends) {
            let current: PreParsedNoPartials[string] = JSON.parse(JSON.stringify(preParsed[ex]));
            //if the parent is also an extended build we need to go deeper
            if (current.kind === "extended") {
                mergeExtension(preParsed, ex, current.build);
                //a new copy is needed, it was modified after recursive merging
                current = JSON.parse(JSON.stringify(preParsed[ex]));
            }
            if (!initial) {
                initial = current;
                continue;
            }
            mergeCoreProperties(initial.build, current.build);
            fixConfigurationConflicts(initial.build, current.build, initial.name, current.name, "configuration");
            mergeExtensionConfiguration(initial.build, current.build, "configuration");
            fixConfigurationConflicts(initial.build, current.build, initial.name, current.name, "configuration_adv");
            mergeExtensionConfiguration(initial.build, current.build, "configuration_adv");
        }
        //and finally merge the extension
        if (initial) {
            mergeCoreProperties(initial.build, build);
            fixConfigurationConflicts(initial.build, build, initial.name, buildName, "configuration");
            mergeExtensionConfiguration(initial.build, build, "configuration");
            fixConfigurationConflicts(initial.build, build, initial.name, buildName, "configuration_adv");
            mergeExtensionConfiguration(initial.build, build, "configuration_adv");
            initial.name = buildName;
            preParsed[buildName] = initial;
        }
    } else {
        let base: PreParsedNoPartials[string] = JSON.parse(JSON.stringify(preParsed[build.extends]));
        //if the parent is also an extended build we need to go deeper
        if (base.kind === "extended") {
            mergeExtension(preParsed, build.extends, base.build);
            //a new copy is needed, it was modified after recursive merging
            base = JSON.parse(JSON.stringify(preParsed[build.extends]));
        }
        mergeCoreProperties(base.build, build);
        fixConfigurationConflicts(base.build, build, build.extends, buildName, "configuration");
        mergeExtensionConfiguration(base.build, build, "configuration");
        fixConfigurationConflicts(base.build, build, build.extends, buildName, "configuration_adv");
        mergeExtensionConfiguration(base.build, build, "configuration_adv");
        base.name = buildName;
        preParsed[buildName] = base;
    }
}

function fixConfigurationConflicts(
    build1: AnyBuildSchema,
    build2: AnyBuildSchema,
    buildName1: string,
    buildName2: string,
    configType: "configuration" | "configuration_adv"
) {
    //if selfCheck, disable wins
    //if not, the extension's choice wins
    //for partials this is called with reverse order so the base's choice wins

    const selfCheck = build1 === build2;

    const build1Enables = build1[configType].enable.map((e, i) => typeof e === "string" ? {name: e, index: i} : {name: e[0], index: i}) || [];
    const build1Disables = build1[configType].disable.map((e, i) => ({name: e, index: i})) || [];
    const build2Enables = build2[configType].enable.map((e, i) => typeof e === "string" ? {name: e, index: i} : {name: e[0], index: i}) || [];
    const build2Disables = build2[configType].disable.map((e, i) => ({name: e, index: i})) || [];

    const removeEnables: number[] = [];
    for (const enable of build1Enables) {
        if (build2Disables.map(d => d.name).includes(enable.name)) {
            if (selfCheck) {
                console.warn(chalk.yellow(`${chalk.underline("[Conflict]")} Build ${buildName1} enables AND disables ${configType} => "${enable.name}". It will be disabled`));
                removeEnables.push(enable.index);
            } else {
                console.warn(chalk.yellow(`${chalk.underline("[Conflict]")} Build ${buildName1} enables ${configType} => "${enable.name}" but ${buildName2} disables it. It will be disabled`));
                removeEnables.push(enable.index);
            }
        }
    }
    for (const toRemove of removeEnables) {
        build1[configType].enable.splice(toRemove, 1);
    }

    const removeDisables: number[] = [];
    for (const disable of build1Disables) {
        if (build2Enables.map(e => e.name).includes(disable.name)) {
            if (!selfCheck) {
                console.warn(chalk.yellow(`${chalk.underline("[Conflict]")} Build ${buildName1} disables ${configType} => "${disable.name}" but ${buildName2} enables it. It will be enabled`));
                removeDisables.push(disable.index);
            }
        }
    }
    for (const toRemove of removeDisables) {
        build1[configType].disable.splice(toRemove, 1);
    }
}

function mergeCoreProperties(
    base: ExtendedBuildSchema | BuildSchema,
    extension: ExtendedBuildSchema | BuildSchema
) {
    base.meta = extension.meta;
    base.active = extension.active;
    base.only = extension.only;
    base.board_env = extension.board_env || base.board_env;
    base.based_on = {
        repo: extension?.based_on?.repo || base?.based_on?.repo,
        path: extension?.based_on?.path || base?.based_on?.path,
        stable_branch: extension?.based_on?.stable_branch || base?.based_on?.stable_branch,
        nightly_branch: extension?.based_on?.nightly_branch || base?.based_on?.nightly_branch
    };
}

// partial merging is exactly the same as extension merging except when there is an enabled option with a value defined in both base and extension.
// in partial merging the base wins but in extension merging the extension wins.
function mergeExtensionConfiguration(
    base: ExtendedBuildSchema | BuildSchema,
    extension: ExtendedBuildSchema | BuildSchema,
    configType: "configuration" | "configuration_adv"
) {
    for (const enable of extension[configType].enable) {
        if (typeof enable === "string") {
            if (!base[configType].enable.includes(enable)) {
                base[configType].enable.push(enable);
            }
        } else {
            const baseEnables = base[configType].enable.map(e => typeof e === "string" ? e : e[0]);
            if (!baseEnables.includes(enable[0])) {
                base[configType].enable.push(enable);
            } else {
                const enableToupdate = base[configType].enable.find(e => e[0] === enable[0]);
                if (enableToupdate && Array.isArray(enableToupdate)) enableToupdate[1] = enable[1];
            }
        }
    }
    for (const disable of extension[configType].disable) {
        if (!base[configType].disable.includes(disable)) {
            base[configType].disable.push(disable);
        }
    }
}

function mergePartialConfiguration(
    base: AnyBuildSchema,
    extension: PartialBuildSchema,
    configType: "configuration" | "configuration_adv"
) {
    for (const enable of extension[configType].enable) {
        if (typeof enable === "string") {
            if (!base[configType].enable.includes(enable)) {
                base[configType].enable.push(enable);
            }
        } else {
            const baseEnables = base[configType].enable.map(e => typeof e === "string" ? e : e[0]);
            if (!baseEnables.includes(enable[0])) {
                base[configType].enable.push(enable);
            }
        }
    }
    for (const disable of extension[configType].disable) {
        if (!base[configType].disable.includes(disable)) {
            base[configType].disable.push(disable);
        }
    }
}
