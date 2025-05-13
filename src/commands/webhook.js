/* eslint-disable no-unused-vars */
/* eslint-disable block-scoped-var */
/* eslint-disable no-redeclare */
/* eslint-disable camelcase */
const {Command,Flags} = require('@oclif/core')
const ngrok = require('ngrok')
const helpers = require('../lib/helpers')
const Paystack = require('../lib/paystack')
const db = require('../lib/db')

class WebhookCommand extends Command {
  async run() {
    let selected_integration = db.read('selected_integration.id')
    let user = db.read('user.id')
    
    // Add debug logging for authentication state
    console.log('Debug - Auth State:')
    console.log('Selected Integration:', selected_integration)
    console.log('User:', user)
    
    if (!selected_integration || !user) {
      this.error("You're not signed in, please run the `paystack login` command before you begin")
    }
    
    const {args, flags} = await this.parse(WebhookCommand)
    console.log('Debug - Command Arguments:', args)
    console.log('Debug - Command Flags:', flags)
    
    switch (args.subcommand) {
    case 'listen': {
      let token = ''
      let expiry = parseInt(db.read('token_expiry'), 10) * 1000
      let now = parseFloat(Date.now().toString())

      console.log('Debug - Token State:')
      console.log('Token Expiry:', new Date(expiry))
      console.log('Current Time:', new Date(now))

      if (expiry > now) {
        token = db.read('token')
        console.log('Debug - Using existing token')
      } else {
        console.log('Debug - Token expired, refreshing integration...')
        try {
          await helpers.promiseWrapper(Paystack.refreshIntegration())
          token = db.read('token')
          console.log('Debug - Successfully refreshed token')
        } catch (error) {
          console.error('Debug - Error refreshing token:', error)
          this.error('Failed to refresh integration token: ' + error.message)
        }
      }

      if (!flags.forward) {
        this.error('To listen to webhook events locally, you have to specify a local route to forward events to using the forward flag e.g --forward localhost:3000/webhook')
      }

      console.log('Debug - Parsing URL:', flags.forward)
      let urlObject
      try {
        urlObject = helpers.parseURL(flags.forward)
        console.log('Debug - Parsed URL:', urlObject)
      } catch (error) {
        console.error('Debug - URL parsing error:', error)
        return helpers.errorLog('Invalid URL format: ' + error.message)
      }

      if(urlObject.hostname !== 'localhost' && urlObject.hostname !== '127.0.0.1'){
        console.error('Debug - Invalid hostname:', urlObject.hostname)
        return helpers.errorLog(`Invalid host provided "${urlObject.hostname}" - You can only forward events to localhost`);
      }
      
      if (!urlObject.port) {
        console.log('Debug - No port specified, defaulting to 80')
        urlObject.port = 80
      }
      if (!urlObject.search || urlObject.search === '?') {
        urlObject.search = ''
      }

      console.log('Debug - Attempting to disconnect existing ngrok sessions...')
      try {
        await ngrok.disconnect()
        await ngrok.kill()
        console.log('Debug - Successfully disconnected and killed existing ngrok sessions')
      } catch (error) {
        console.warn('Debug - Ngrok disconnect/kill error (might be ok if no prior session):', error)
      }

      console.log('Debug - Attempting to establish ngrok connection on port:', urlObject.port)
      let ngrokHostUrl
      try {
        const connectOpts = {
          addr: parseInt(urlObject.port, 10),
          proto: 'http',
        }
        console.log('Debug - ngrok connect options:', connectOpts)
        ngrokHostUrl = await ngrok.connect(connectOpts)
        console.log('Debug - Ngrok connection established. Public URL:', ngrokHostUrl)
      } catch (error) {
        console.error('Debug - Ngrok connect error:', error)
        this.error('Failed to establish ngrok tunnel: ' + (error.message || error))
        return
      }

      if (!ngrokHostUrl) {
        this.error('Failed to get a public URL from ngrok.connect()')
        return
      }
      
      const tempUrl = new URL(ngrokHostUrl)
      let fullNgrokForwardUrl = tempUrl.origin + urlObject.pathname + urlObject.search
      console.log('Debug - Complete ngrok forwarding URL for Paystack:', fullNgrokForwardUrl)

      let domain = 'test'
      if (flags.domain === 'live') {
        domain = 'live'
      }
      console.log('Debug - Using domain:', domain)

      let originalWebhookUrl = db.read('selected_integration.' + domain + '_webhook_endpoint')
      console.log('Debug - Original webhook URL:', originalWebhookUrl)
      
      helpers.infoLog(`Forwarding webhook events from ${fullNgrokForwardUrl} to ${flags.forward}`)

      console.log('Debug - Attempting to set Paystack webhook URL to:', fullNgrokForwardUrl)
      var [err, result] = await helpers.promiseWrapper(Paystack.setWebhook(fullNgrokForwardUrl, token, db.read('selected_integration.id'), domain))
      if (err) {
        console.error('Debug - Error setting Paystack webhook:', err)
        this.error('Failed to set Paystack webhook URL: ' + (err.message || err))
        return
      }
      console.log('Debug - Successfully set Paystack webhook URL')

      this.log('Webhook events would now be forwarded to ' + flags.forward + ' (via ' + ngrokHostUrl + ')')
      
      console.log('Debug - Getting ngrok API client...')
      const api = ngrok.getApi()
      if (!api) {
        this.error('Failed to get ngrok API client after connecting')
        return
      }

      let activeTunnelsList
      try {
        console.log('Debug - Attempting to list tunnels using api.listTunnels()')
        activeTunnelsList = await api.listTunnels()
        if (!activeTunnelsList) {
          console.warn('Debug - api.listTunnels() returned falsy value:', activeTunnelsList)
          activeTunnelsList = []
        }
        console.log('Debug - Active tunnels list from api.listTunnels():', JSON.stringify(activeTunnelsList, null, 2))
      } catch (error) {
        console.error('Debug - Error listing ngrok tunnels using api.listTunnels():', error)
        this.error('Failed to list ngrok tunnels: ' + (error.message || error))
        return
      }

      let tunnelObject
      if (activeTunnelsList && activeTunnelsList.length > 0) {
        for (let i = 0; i < activeTunnelsList.length; i++) {
          if (activeTunnelsList[i].public_url === ngrokHostUrl) {
            tunnelObject = activeTunnelsList[i]
            console.log('Debug - Found matching tunnel object for inspector:', JSON.stringify(tunnelObject, null, 2))
            break
          }
        }
      } else {
        console.warn('Debug - No active tunnels found in the list from api.listTunnels()')
      }
      
      if (!tunnelObject) {
        console.error('Debug - Could not find matching tunnel object for URL:', ngrokHostUrl, 'in active tunnels list:', JSON.stringify(activeTunnelsList, null, 2))
        this.warn('Warning: Failed to find the exact tunnel object for the inspector. The webhook forwarding should still work. Inspector might be limited.')
      }

      if (process.platform === 'win32') {
        var rl = require('readline').createInterface({
          input: process.stdin,
          output: process.stdout,
        })
        rl.on('SIGINT', function () {
          process.emit('SIGINT')
        })
      }

      process.on('SIGINT', async () => {
        console.log('Debug - Received SIGINT, cleaning up...')
        this.log('Cleaning up: Restoring original Paystack webhook and disconnecting ngrok...')
        var [sigintErr, sigintResult] = await helpers.promiseWrapper(Paystack.setWebhook(originalWebhookUrl, token, db.read('selected_integration.id'), domain))
        if (sigintErr) {
          console.error('Debug - Error restoring original Paystack webhook:', sigintErr)
          this.error('Failed to restore original Paystack webhook URL: ' + (sigintErr.message || sigintErr))
        } else {
          console.log('Debug - Successfully restored original Paystack webhook URL')
        }
        try {
          await ngrok.disconnect()
          await ngrok.kill()
          console.log('Debug - ngrok disconnected and process killed successfully on SIGINT.')
        } catch (ngrokErr) {
          console.error('Debug - Error disconnecting/killing ngrok on SIGINT:', ngrokErr)
        }
        process.exit()
      })

      if (tunnelObject) {
        console.log('Debug - Starting webhook inspector with ngrok API client and tunnel object:', JSON.stringify(tunnelObject, null, 2))
        helpers.webhookInspector(api, tunnelObject)
      } else {
        console.warn("Debug - Webhook inspector not started as the specific tunnel object couldn't be found.")
        this.log("Webhook forwarding active. Inspector details might be unavailable. Check ngrok dashboard at http://127.0.0.1:4040 if running.")
      }
      break
    }
    case 'ping': {
      await helpers.promiseWrapper(Paystack.refreshIntegration())
      var [e, response] = await helpers.promiseWrapper(Paystack.pingWebhook(flags))
      helpers.infoLog('-  - - - - WEBHOOK RESPONSE - - - -  - -')
      helpers.infoLog(response.code + ' - - ' + response.text)
      if (helpers.isJson(response.data)) {
        helpers.jsonLog(response.data)
      } else {
        helpers.infoLog(response.data)
      }
      break
    }
    }
  }
}

WebhookCommand.description = 'Listen for webhook events locally, and ping your webhook URL from the CLI'
WebhookCommand.args = [
  {name: 'subcommand'},
]

WebhookCommand.flags = {
  forward: Flags.string({description: 'Local URL to forward webhook events to (e.g., localhost:3000/webhook)'}),
  domain: Flags.string({description: 'Paystack domain to use (test or live)', default: 'test'}),
  event: Flags.string({description: 'The event type to send for a webhook ping (e.g., transfer.success)'}),

}
module.exports = WebhookCommand
