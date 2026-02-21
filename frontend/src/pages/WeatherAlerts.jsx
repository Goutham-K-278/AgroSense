const alerts = [
  { title: 'Heavy Rain Warning', area: 'Delta Districts', severity: 'High', tip: 'Avoid spraying for next 24 hours.' },
  { title: 'Heat Stress Window', area: 'Western Belt', severity: 'Medium', tip: 'Increase drip intervals in afternoon.' },
  { title: 'Strong Wind Advisory', area: 'Southern Zone', severity: 'Low', tip: 'Secure nursery covers and young plants.' },
]

function WeatherAlerts() {
  return (
    <section>
      <h1 className="text-3xl font-bold text-emerald-700">Weather Alerts</h1>
      <p className="mt-2 text-sm text-slate-600">Actionable weather intelligence for farmers.</p>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {alerts.map((alert) => (
          <article key={alert.title} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-emerald-100">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-800">{alert.title}</h2>
              <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                {alert.severity}
              </span>
            </div>
            <p className="mt-2 text-sm text-slate-600">{alert.area}</p>
            <p className="mt-3 text-sm text-slate-700">{alert.tip}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

export default WeatherAlerts
