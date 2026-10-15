import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import YAML from 'yaml'

const workflow = YAML.parse(await readFile('../.github/workflows/approve-contribution.yml', 'utf8'))
const steps = workflow.jobs.approve.steps
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const runStep = (name, github, env = {}) => {
  const step = steps.find((step) => step.name === name)
  return new AsyncFunction('github', 'context', 'process', step.with.script)(
    github,
    { repo: { owner: 'example', repo: 'ambassadors' }, issue: { number: 12 } },
    { env },
  )
}

test('approval validates before opening and merging, then deploys and finalizes only after merge', () => {
  const names = steps.map((step) => step.name)
  const validation = steps.find((step) => step.name === 'Validate the prepared record')
  for (const command of ['validate:data', 'test', 'build', 'verify:pages']) {
    assert.ok(validation.run.includes(`npm ${command === 'test' ? '' : 'run '}${command}`))
  }
  assert.ok(names.indexOf(validation.name) < names.indexOf('Open contribution record pull request'))
  assert.ok(names.indexOf('Open contribution record pull request') < names.indexOf('Merge the validated contribution record'))
  for (const name of ['Queue dashboard rebuild', 'Credit and close the submission']) {
    assert.ok(names.indexOf(name) > names.indexOf('Merge the validated contribution record'))
    assert.equal(steps.find((step) => step.name === name).if, "steps.merge.outcome == 'success'")
  }
  assert.equal(workflow.permissions.actions, 'write')
})

test('automatic merge pins the prepared head and rejects an unsuccessful merge', async () => {
  let request
  const github = { rest: { pulls: { merge: async (args) => {
    request = args
    return { data: { merged: true } }
  } } } }
  await runStep('Merge the validated contribution record', github, { PR_NUMBER: '42', HEAD_SHA: 'prepared-commit' })
  assert.deepEqual(request, {
    owner: 'example', repo: 'ambassadors', pull_number: 42, sha: 'prepared-commit', merge_method: 'squash',
  })
  await assert.rejects(runStep('Merge the validated contribution record', github, { PR_NUMBER: '42' }), /Missing validated/)
  github.rest.pulls.merge = async () => ({ data: { merged: false, message: 'Blocked by repository rules' } })
  await assert.rejects(runStep('Merge the validated contribution record', github, { PR_NUMBER: '42', HEAD_SHA: 'prepared-commit' }), /Blocked by repository rules/)
})

test('bot merge explicitly dispatches deployment and credits the source issue', async () => {
  let dispatch
  const calls = []
  const github = { rest: {
    actions: { createWorkflowDispatch: async (args) => { dispatch = args } },
    issues: {
      getLabel: async () => { throw Object.assign(new Error('Not found'), { status: 404 }) },
      createLabel: async (args) => { calls.push(['label', args]) },
      get: async () => ({ data: { labels: ['submission:ambassador', { name: 'status:pr-open' }] } }),
      setLabels: async (args) => { calls.push(['labels', args]) },
      update: async (args) => { calls.push(['close', args]) },
      createComment: async (args) => { calls.push(['comment', args]) },
    },
  } }
  await runStep('Queue dashboard rebuild', github)
  assert.deepEqual(dispatch, { owner: 'example', repo: 'ambassadors', workflow_id: 'deploy-dashboard.yml', ref: 'main' })
  await runStep('Credit and close the submission', github, { PR_NUMBER: '42' })
  assert.deepEqual(calls.map(([name]) => name), ['label', 'labels', 'close', 'comment'])
  assert.deepEqual(calls[1][1].labels, ['submission:ambassador', 'status:credited'])
  assert.equal(calls[2][1].issue_number, 12)
  assert.equal(calls[2][1].state, 'closed')
  assert.match(calls[3][1].body, /automatically merged in #42/)
})
