import {mkdir, rm, writeFile, readFile} from "fs/promises";
import {randomInt, createHash} from "crypto";
import chalk from "chalk";
import dayjs from "dayjs";
import {getLatestStable, getLatestNightly, createRelease, uploadAsset} from "./github";
import {loadBuilds, BuildSchema} from "./prepare";
import {processBuild} from "./build";
import {registerQuote} from "./quote";
import {downloadStable, commitTrackers, downloadNightly} from "./system";

const dryRun = process.argv[2] === "--dry";
if (dryRun) {
    console.log(chalk.yellow("This is a dry run. Repo will not be modified and releases won't be created"));
}

(async function main() {
    const latestStable = await getLatestStable();
    const latestNightly = await getLatestNightly();
    await dirSetup();
    registerQuote();
    const builds = await loadBuilds();

    if (Object.keys(builds).length === 0) {
        console.log(chalk.green("nothing to do, bye"));
        return;
    }

    const [ignoreStable, stableBuilds] = await shouldBuild(latestStable, "stable", builds);
    const [ignoreNightly, nightlyBuilds] = await shouldBuild(latestNightly, "nightly", builds);

    if (ignoreStable && ignoreNightly) {
        console.log(chalk.green("nothing to do, bye"));
        return;
    }

    if (!ignoreStable) {
        console.log(chalk.green(`downloading stable ${chalk.underline(latestStable)}`));
        await downloadStable(latestStable);
        await doBuild(latestStable, "stable", stableBuilds);

    }

    if (!ignoreNightly) {
        console.log(chalk.green(`downloading nightly ${chalk.underline(latestNightly)}`));
        await downloadNightly();
        await doBuild(latestNightly, "nightly", nightlyBuilds);
    }

    if (!dryRun) {
        console.log(chalk.green("checkpointing new releases"));
        await commitTrackers();
    }

    console.log(chalk.green("all done!"));
})().catch(function(err) {
    console.error(chalk.red(err.message));
    process.exit(1);
});

async function dirSetup() {
    try {
        await rm("./dist", {recursive: true, force: true});
    } catch (_e) {} // eslint-disable-line
    await mkdir("./dist");
    await mkdir("./dist/assets");
}

type BuildDefs = {
    [key: string]: {
        version: string,
        md5: string,
        build: BuildSchema,
        action: "create" | "update" | "ignore",
        assetId?: number
    }
};

async function shouldBuild(
    latestVersion: string,
    kind: "stable" | "nightly",
    loadedBuilds: {[key: string]: BuildSchema}
): Promise<[boolean, BuildDefs]> {
    const newBuilds: BuildDefs = {};
    try {
        console.log(chalk.green(`checking builds for ${chalk.underline(kind)} release`));
        const trackedBuilds: {[key: string]: {version: string, md5: string, assetId: number}} = require(`../last_${kind}.json`);
        for (const [buildName, loadedBuild] of Object.entries(loadedBuilds)) {
            const hash = createHash("md5");
            hash.update(await readFile(buildName));
            const md5 = hash.digest("hex");
            if (!trackedBuilds[buildName]) {
                //it's a new build
                newBuilds[buildName] = {version: latestVersion, md5, build: loadedBuild, action: "create"};
                console.log(chalk.cyan(`[new build added] ${chalk.underline(buildName)}`));
            } else if (trackedBuilds[buildName] && trackedBuilds[buildName].version !== latestVersion) {
                //existing build but on older version
                newBuilds[buildName] = {version: latestVersion, md5, build: loadedBuild, action: "create"};
                console.log(chalk.cyan(`[needs update] ${chalk.underline(buildName)}`));
            } else if (trackedBuilds[buildName] && md5 !== trackedBuilds[buildName].md5) {
                //build's schema was changed
                newBuilds[buildName] = {version: latestVersion, md5, build: loadedBuild, action: "update", assetId: trackedBuilds[buildName].assetId};
                console.log(chalk.cyan(`[build changed] ${chalk.underline(buildName)}`));
            } else {
                //up to date
                newBuilds[buildName] = {version: latestVersion, md5, build: loadedBuild, action: "ignore", assetId: trackedBuilds[buildName].assetId};
                console.log(chalk.cyan(`[up-to-date] ${chalk.underline(buildName)}`));
            }
        }
    } catch (_e) {
        //tracker does not exist, probably the first run
        for (const [buildName, loadedBuild] of Object.entries(loadedBuilds)) {
            const hash = createHash("md5");
            hash.update(await readFile(buildName));
            const md5 = hash.digest("hex");
            newBuilds[buildName] = {version: latestVersion, md5, build: loadedBuild, action: "create"};
            console.log(chalk.cyan(`[new build added] ${chalk.underline(buildName)}`));
        }
    }

    const ignore = Object.values(newBuilds).every(b => b.action === "ignore");

    return [ignore, newBuilds];
}

async function doBuild(latestVersion: string, kind: "stable" | "nightly", buildDefs: BuildDefs) {
    const currentDate = dayjs().format("YYYYMMDD");
    const currentDateTime = dayjs().format("YYYYMMDDHHmm");
    const timestamp = dayjs().unix();
    const assets: {buildName: string, filename: string, buildPath: string, action: "create" | "update", assetId?: number}[] = [];

    for (const [buildName, buildDef] of Object.entries(buildDefs)) {
        if (buildDef.action === "ignore") continue;
        console.log(chalk.green(`building ${chalk.underline(buildName)}`));
        const buildPath = await processBuild(buildName, buildDef.build, kind, latestVersion);
        let filename = buildDef.build.meta[`${kind}_name`]
            .replace("{{marlin_version}}", latestVersion)
            .replace("{{current_date}}", currentDate)
            .replace("{{timestamp}}", timestamp.toString())
            .replace("{{uid}}", randomInt(100000, 999999).toString());
        if (!filename.endsWith(".bin")) filename += ".bin";
        assets.push({buildName, filename, buildPath, action: buildDef.action, assetId: buildDef.assetId});
    }

    if (dryRun) return;

    console.log(chalk.green("creating release"));
    const uploadUrl = await createRelease(latestVersion, kind, currentDateTime);
    for (const asset of assets) {
        console.log(chalk.green(`uploading ${chalk.underline(asset.filename)}`));
        const assetId = await uploadAsset(uploadUrl, asset);
        buildDefs[asset.buildName].assetId = assetId;
    }
    for (const buildDef of Object.values(buildDefs)) {
        //@ts-ignore
        delete buildDef.build;
        //@ts-ignore
        delete buildDef.action;
    }
    await writeFile(`./last_${kind}.json`, JSON.stringify(buildDefs, null, 4));
}
