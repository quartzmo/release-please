/**
 * Copyright 2019 Google LLC. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {PullsListResponseItem} from '@octokit/rest';
import * as semver from 'semver';

import {checkpoint, CheckpointType} from './checkpoint';
import {ConventionalCommits} from './conventional-commits';
import {GitHub, GitHubReleasePR, GitHubTag} from './github';
import {Changelog} from './updaters/changelog';
import {PackageJson} from './updaters/package-json';
import {SamplesPackageJson} from './updaters/samples-package-json';
import {Update} from './updaters/update';

const parseGithubRepoUrl = require('parse-github-repo-url');

export enum ReleaseType {
  Node = 'node'
}

export interface ReleasePROptions {
  bumpMinorPreMajor?: boolean;
  label: string;
  issueLabel?: string;
  token?: string;
  repoUrl: string;
  packageName: string;
  releaseAs?: string;
  releaseType: ReleaseType;
}

export interface ReleaseCandidate {
  version: string;
  previousTag?: string;
}

export class ReleasePR {
  labels: string[];
  gh: GitHub;
  bumpMinorPreMajor?: boolean;
  repoUrl: string;
  token: string|undefined;
  packageName: string;
  releaseAs?: string;
  releaseType: ReleaseType;

  constructor(options: ReleasePROptions) {
    this.bumpMinorPreMajor = options.bumpMinorPreMajor || false;
    this.labels = options.label.split(',');
    this.repoUrl = options.repoUrl;
    this.token = options.token;
    this.packageName = options.packageName;
    this.releaseAs = options.releaseAs;
    this.releaseType = options.releaseType;

    this.gh = this.gitHubInstance();
  }

  async run(): Promise<number|undefined> {
    const pr: GitHubReleasePR|undefined =
        await this.gh.findMergedReleasePR(this.labels);
    if (pr) {
      // a PR already exists in the autorelease: pending state.
      checkpoint(
          `pull #${pr.number} ${pr.sha} has not yet been released`,
          CheckpointType.Failure);
      return pr.number;
    } else {
      switch (this.releaseType) {
        case ReleaseType.Node:
          return await this.nodeRelease();
        default:
          throw Error('unknown release type');
      }
    }
  }

  private async nodeRelease(): Promise<number|undefined> {
    const latestTag: GitHubTag|undefined = await this.gh.latestTag();
    const commits: string[] =
        await this.commits(latestTag ? latestTag.sha : undefined);

    const cc = new ConventionalCommits({
      commits,
      githubRepoUrl: this.repoUrl,
      bumpMinorPreMajor: this.bumpMinorPreMajor
    });
    const candidate: ReleaseCandidate =
        await this.coerceReleaseCandidate(cc, latestTag);

    const changelogEntry = await cc.generateChangelogEntry({
      version: candidate.version,
      currentTag: `v${candidate.version}`,
      previousTag: candidate.previousTag
    });

    // don't create a release candidate until user facing changes
    // (fix, feat, BREAKING CHANGE) have been made; a CHANGELOG that's
    // one line is a good indicator that there were no interesting commits.
    if (changelogEntry.split('\n').length === 1) {
      checkpoint(
          `no user facing commits found since ${
              latestTag ? latestTag.sha : 'beginning of time'}`,
          CheckpointType.Failure);
      return undefined;
    }

    const updates: Update[] = [];

    updates.push(new Changelog({
      path: 'CHANGELOG.md',
      changelogEntry,
      version: candidate.version,
      packageName: this.packageName
    }));

    updates.push(new PackageJson({
      path: 'package.json',
      changelogEntry,
      version: candidate.version,
      packageName: this.packageName
    }));

    updates.push(new SamplesPackageJson({
      path: 'samples/package.json',
      changelogEntry,
      version: candidate.version,
      packageName: this.packageName
    }));

    const sha = this.shaFromCommits(commits);
    const title = `chore: release ${candidate.version}`;
    const body =
        `:robot: I have created a release \\*beep\\* \\*boop\\* \n---\n${
            changelogEntry}`;
    const pr: number = await this.gh.openPR({
      branch: `release-v${candidate.version}`,
      version: candidate.version,
      sha,
      updates,
      title,
      body,
      labels: this.labels
    });
    await this.gh.addLabels(pr, this.labels);
    await this.closeStaleReleasePRs(pr);
    return pr;
  }

  private async closeStaleReleasePRs(currentPRNumber: number) {
    const prs: PullsListResponseItem[] =
        await this.gh.findOpenReleasePRs(this.labels);
    for (let i = 0, pr: PullsListResponseItem; i < prs.length; i++) {
      pr = prs[i];
      // don't close the most up-to-date release PR.
      if (pr.number !== currentPRNumber) {
        checkpoint(`closing pull #${pr.number}`, CheckpointType.Failure);
        await this.gh.closePR(pr.number);
      }
    }
  }

  private async coerceReleaseCandidate(
      cc: ConventionalCommits,
      latestTag: GitHubTag|undefined): Promise<ReleaseCandidate> {
    const previousTag = latestTag ? latestTag.name : undefined;
    let version = latestTag ? latestTag.version : '1.0.0';

    if (latestTag && !this.releaseAs) {
      const bump = await cc.suggestBump(version);
      const candidate = semver.inc(version, bump.releaseType);
      if (!candidate) throw Error(`failed to increment ${version}`);
      version = candidate;
    } else if (this.releaseAs) {
      version = this.releaseAs;
    }

    return {version, previousTag};
  }

  private async commits(sha: string|undefined): Promise<string[]> {
    const commits = await this.gh.commitsSinceSha(sha);
    if (commits.length) {
      checkpoint(
          `found ${commits.length} commits since ${sha}`,
          CheckpointType.Success);
    } else {
      checkpoint(`no commits found since ${sha}`, CheckpointType.Failure);
    }
    return commits;
  }

  private gitHubInstance(): GitHub {
    const [owner, repo] = parseGithubRepoUrl(this.repoUrl);
    return new GitHub({token: this.token, owner, repo});
  }

  private shaFromCommits(commits: string[]): string {
    // The conventional commits parser expects an array of string commit
    // messages terminated by `-hash-` followed by the commit sha. We
    // piggyback off of this, and use this sha when choosing a
    // point to branch from for PRs.
    const split = commits[0].split('-hash-');
    return split[split.length - 1].trim();
  }
}
