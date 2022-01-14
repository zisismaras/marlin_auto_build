import {exec} from "child_process";
import retry from "p-retry";

export function downloadStable(tag: string) {
    return retry(() => new Promise<void>(function(resolve, reject) {
        exec(`cd ./dist && \
            wget https://api.github.com/repos/MarlinFirmware/Marlin/tarball/${tag} && \
            mkdir marlin_stable && \
            tar -xvf ${tag} -C marlin_stable --strip-components 1
        `, function(err) {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    }), {retries: 3});
}

export function downloadNightly() {
    return retry(() => new Promise<void>(function(resolve, reject) {
        exec(`cd ./dist && \
            git clone -b bugfix-2.0.x https://github.com/MarlinFirmware/Marlin.git --depth 1 marlin_nightly
        `, function(err) {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    }), {retries: 3});
}

export function cloneConfig(repo: string, branch: string, path: string) {
    return retry(() => new Promise<void>(function(resolve, reject) {
        exec(`cd ./dist/current_build && \
            git clone -b ${branch} ${repo} --depth 1 __build_configs && \
            cp ./__build_configs/${path}/* ./Marlin
        `, function(err) {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    }), {retries: 3});
}

export function runPlatformIO(boardEnv: string) {
    return new Promise<void>(function(resolve, reject) {
        const ps = exec(`cd ./dist/current_build/ && \
            PATH=$PATH:~/.platformio/penv/bin platformio run -e ${boardEnv}
        `);
        //too noicy, keep only stderr
        // ps.stdout?.on("data", function(d) {
        //     console.log(d.toString());
        // });
        ps.stderr?.on("data", function(d) {
            console.error(d.toString());
        });
        ps.on("exit", function(code) {
            if (code && code > 0) {
                reject(new Error("Failed to build firmware"));
            } else {
                resolve();
            }
        });
    });
}

export async function commitTrackers() {
    await new Promise<void>(function(resolve, reject) {
        exec(`cd .. && \
            rm -rf marlin_auto_build && \
            git config user.name "${process.env.GITHUB_ACTOR}" && \
            git config user.email "${process.env.GITHUB_ACTOR}@users.noreply.github.com" && \
            git add . && \
            git commit -m "new build"
        `, function(err) {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
    return retry(() => new Promise<void>(function(resolve, reject) {
        exec("git push", function(err) {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    }), {retries: 3});
}
