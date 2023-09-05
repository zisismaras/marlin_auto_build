import {readFile} from "fs/promises";
import axios from "axios";
import retry from "p-retry";
const pkg = require("../package.json");

const request = axios.create({
    baseURL: "https://api.github.com/repos",
    headers: {
        "user-agent": `marlin_auto_build/${pkg.version}`,
        "Accept": "application/vnd.github.v3+json",
        "authorization": process.argv[2] === "--dev" ? "" : `Bearer ${process.env.GITHUB_TOKEN}`
    }
});

export async function getLatestStable(): Promise<string> {
    const res = await retry(() => request.get("/MarlinFirmware/Marlin/releases/latest"), {retries: 3});
console.log(`checking for latest stable at "https://api.github.com/repos/MarlinFirmware/Marlin/releases/latest"`);    
    const release = res.data;
    if (isMarlin2(release.tag_name)) {
        return release.tag_name;
    } else {
        throw new Error("No valid stable release tag found");
    }
}

function isMarlin2(version: string) {
    try {
        return parseInt(version.split("")[0]) >= 2;
    } catch (_e) {
        return false;
    }
}

export async function getLatestNightly(): Promise<string> {
    const res = await retry(() => request.get("/MarlinFirmware/Marlin/commits?sha=bugfix-2.1.x&per_page=1"), {retries: 3});
console.log(`checking for latest bugfix 2.1.x at "https://api.github.com/repos/MarlinFirmware/Marlin/commits?sha=bugfix-2.1.x&per_page=1"`);    
    return res.data[0].sha;
}

export async function createRelease(
    version: string,
    kind: "stable" | "nightly",
    currentDateTime: string
): Promise<string> {
    //check if release already exists
    try {
        const uploadUrl: string = await retry(async function() {
            const res = await request.get(`/${process.env.GITHUB_REPOSITORY}/releases/tags/${kind}-${version}`);
            if (res.status === 404) {
                throw new retry.AbortError(res.statusText);
            }
            if (res.data && res.data.upload_url) {
                return res.data.upload_url;
            }
        }, {retries: 3});
        if (uploadUrl) {
            return uploadUrl;
        }
    } catch (e) {
        //@ts-ignore
        if (e.response.status !== 404) {
            throw e;
        }
    }

    //create new release
    let body: string;
    let name: string;
    let tagName: string;
    let prerelease: boolean;
    if (kind === "stable") {
        name = `${kind}-${version}`;
        tagName = `${kind}-${version}`;
        body = `https://github.com/MarlinFirmware/Marlin/releases/tag/${version}`;
        prerelease = false;
    } else {
        name = `${kind}-${currentDateTime}`;
        tagName = `${kind}-${version}`;
        body = `https://github.com/MarlinFirmware/Marlin/tree/${version}`;
        prerelease = true;
    }
    const res = await retry(function() {
        return request.post(`/${process.env.GITHUB_REPOSITORY}/releases`, {
            tag_name: tagName,
            name,
            body,
            prerelease
        });
    }, {retries: 3});
    if (res.data && res.data.upload_url) {
        return res.data.upload_url;
    } else {
        throw new Error("Could not create github release");
    }
}

export async function uploadAsset(
    uploadUrl: string,
    asset: {
        filename: string,
        buildPath: string,
        action: "create" | "update",
        assetId?: number
    }
): Promise<number> {
    const file = await readFile(asset.buildPath);
    if (asset.action === "create") {
        const res = await retry(async function() {
            return axios.post(`${uploadUrl.split("{")[0]}?name=${asset.filename}`, file, {
                headers: {
                    "user-agent": `marlin_auto_build/${pkg.version}`,
                    "Accept": "application/vnd.github.v3+json",
                    "authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
                    "Content-Type": "application/octet-stream"
                }
            });
        }, {retries: 3});
        if (res.data && res.data.id) {
            return res.data.id;
        } else {
            throw new Error("Could not upload github asset");
        }
    } else {
        //delete old asset
        await retry(function() {
            return request.delete(`/${process.env.GITHUB_REPOSITORY}/releases/assets/${asset.assetId}`);
        }, {retries: 3});
        //re-upload
        const res = await retry(async function() {
            return axios.post(`${uploadUrl.split("{")[0]}?name=${asset.filename}`, file, {
                headers: {
                    "user-agent": `marlin_auto_build/${pkg.version}`,
                    "Accept": "application/vnd.github.v3+json",
                    "authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
                    "Content-Type": "application/octet-stream"
                }
            });
        }, {retries: 3});
        if (res.data && res.data.id) {
            return res.data.id;
        } else {
            throw new Error("Could not upload github asset");
        }
    }
}
