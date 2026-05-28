require('dotenv').config({ path: '.env.local' })

const Seneca = require('seneca')

run()

async function run() {
  const seneca = Seneca({ legacy: false })
    .test()
    .use('promisify')
    .use('entity')
    .use('..', {
      driver: 'opensearch',
      map: {
        'foo/chunk': '*',
      },
      index: {
        exact: process.env.SENECA_OPENSEARCH_TEST_INDEX,
      },
      opensearch: {
        node: process.env.SENECA_OPENSEARCH_TEST_NODE,
      },
    })

  await seneca.ready()

  const id = '1%3A0%3AvUrfCY4BB33NxQZd-DrQ'
  const load0 = await seneca.entity('foo/chunk').load$(id)
  console.log('load0', load0)
}
